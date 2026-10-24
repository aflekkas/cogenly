/**
 * MachineSetup: gets this machine ready to pair. It reports Tailscale's state
 * as a checklist and runs each step it can: installing, turning Tailscale on,
 * starting the sign-in, and putting this server behind Tailscale Serve. Steps
 * that wait on the user (a sign-in page, the tailnet's HTTPS approval) hand
 * back Tailscale's link and finish by themselves in the background. Every
 * transport (WebSocket RPC, MCP, CLI) calls this service.
 *
 * A Serve mapping that already points at this server, such as one made by
 * hand with `tailscale serve`, is adopted: Cogenly starts accepting what Serve
 * forwards instead of refusing peers. See docs/user/machines.md.
 */
import {
  MachineSetupError,
  type MachineSetupStatus,
  type MachineSetupStepId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import {
  buildMachineSetupStatus,
  emptyProgress,
  type MachineSetupObservation,
  type MachineSetupOperation,
  type MachineSetupProgress,
  planStep,
} from "./machineSetupSteps.ts";
import * as TailscaleHost from "./TailscaleHost.ts";
import * as TailscaleServeMode from "./TailscaleServeMode.ts";
import { chooseServePort } from "./tailscaleState.ts";

/** How often a subscribed client sees Tailscale re-checked. */
const SUBSCRIBE_RECHECK = "5 seconds";

export class MachineSetup extends Context.Service<
  MachineSetup,
  {
    readonly status: Effect.Effect<MachineSetupStatus>;
    /** The status now, then whenever it changes; re-checked while subscribed. */
    readonly subscribe: Stream.Stream<MachineSetupStatus>;
    /** Starts one step and returns the status at once; it may finish later. */
    readonly runStep: (
      step: MachineSetupStepId,
    ) => Effect.Effect<MachineSetupStatus, MachineSetupError>;
    /**
     * The way back out of the "expose" step: removes this server's Serve
     * mapping and saves Serve as off, so it stays off across restarts.
     * Returns the updated status; the removal may finish in the background.
     */
    readonly disableServe: Effect.Effect<MachineSetupStatus, MachineSetupError>;
    /**
     * Called once the server listens on `localPort`. Points a saved Serve
     * mapping at this run's port, or adopts one made by hand.
     */
    readonly start: (localPort: number) => Effect.Effect<void>;
    /**
     * Peer ingress refused a request Tailscale Serve forwarded. Checks, at
     * most every half minute, whether Serve fronts this server, adopting the
     * mapping if so or logging why not. True when Serve is now accepted.
     */
    readonly adoptServe: Effect.Effect<boolean>;
  }
>()("cogenly-server/tailscale/MachineSetup") {}

const ADOPT_RECHECK_MS = 30_000;

const without = <A>(set: ReadonlySet<A>, value: A): ReadonlySet<A> => {
  const next = new Set(set);
  next.delete(value);
  return next;
};
const adding = <A>(set: ReadonlySet<A>, value: A): ReadonlySet<A> => new Set(set).add(value);

const problemFor = (
  step: MachineSetupStepId,
  reason: "permission-denied" | "timed-out" | "not-found" | "other",
): string | null => {
  switch (reason) {
    case "permission-denied":
      return null; // The step shows the command to run instead.
    case "timed-out":
      return step === "sign-in"
        ? "The Tailscale sign-in page expired. Sign in again."
        : step === "install"
          ? "Installing Tailscale took too long. Try again, or install it yourself."
          : "Tailscale is still waiting for approval. Try again once HTTPS is approved.";
    case "not-found":
      return "Tailscale couldn't be started on this machine. Check that it is installed.";
    case "other":
      return step === "install"
        ? "Installing Tailscale didn't finish. Try again, or install it yourself."
        : step === "expose" || step === "enable-https" || step === "disable-expose"
          ? "Tailscale Serve didn't accept the setup. Run `tailscale serve status` on this machine to see why."
          : "Tailscale didn't finish that step. Try again.";
  }
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* TailscaleHost.TailscaleHost;
  const serveMode = yield* TailscaleServeMode.TailscaleServeMode;
  const identity = yield* MachineIdentity.MachineIdentity;
  const layerScope = yield* Effect.scope;

  const progress = yield* Ref.make<MachineSetupProgress>(emptyProgress);
  const localPort = yield* Ref.make(config.port);
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const update = (f: (current: MachineSetupProgress) => MachineSetupProgress) =>
    Ref.update(progress, f).pipe(Effect.andThen(notify));

  /** A mapping already pointing at this server is Serve fronting it: accept it. */
  const adoptExisting = (observation: MachineSetupObservation) =>
    Effect.gen(function* () {
      if (observation.serveMode.enabled || observation.status?.backendState !== "Running") {
        return observation;
      }
      // Turned off on purpose: a mapping left running stays unused until setup runs again.
      if (yield* serveMode.optedOut) return observation;
      const choice = chooseServePort(
        observation.serveMappings ?? [],
        observation.localPort,
        observation.serveMode.servePort,
      );
      if (choice._tag !== "ours") return observation;
      if (choice.funnel) {
        yield* Effect.logWarning(
          "Tailscale Serve fronts this server with Funnel on, so it is public; not accepting its forwarded requests",
          { servePort: choice.port },
        );
        return observation;
      }
      const next = { enabled: true, servePort: choice.port, localPort: observation.localPort };
      yield* serveMode.set(next);
      yield* Effect.logInfo("Adopted the existing Tailscale Serve mapping for this server", {
        servePort: choice.port,
      });
      return { ...observation, serveMode: next };
    });

  const observe = Effect.gen(function* () {
    const [setupHost, probe, mode, self, current, port] = yield* Effect.all(
      [
        host.host,
        host.probe,
        serveMode.current,
        identity.self,
        Ref.get(progress),
        Ref.get(localPort),
      ],
      { concurrency: "unbounded" },
    );
    const observation: MachineSetupObservation = {
      machineName: self.name,
      host: setupHost,
      installed: probe.installed,
      version: probe.version,
      status: probe.status,
      serveMappings: probe.serveMappings,
      localPort: port,
      serveMode: mode,
      // A sign-in page Tailscale itself reports supersedes one remembered here.
      progress:
        probe.status?.backendState === "Running" && current.loginUrl !== null
          ? { ...current, loginUrl: null }
          : current,
    };
    return yield* adoptExisting(observation);
  });

  const status: MachineSetup["Service"]["status"] = observe.pipe(
    Effect.flatMap((observation) =>
      DateTime.now.pipe(Effect.map((now) => buildMachineSetupStatus(observation, now))),
    ),
    Effect.withSpan("MachineSetup.status"),
  );

  /** Where a step's waiting link is kept while the user follows it. */
  const linkField = (operation: MachineSetupOperation) =>
    operation === "serve"
      ? "serveApprovalUrl"
      : operation === "login" || operation === "connect"
        ? "loginUrl"
        : null;

  /**
   * Runs one operation in the background. Links come back to the status at
   * once; the outcome lands when the command ends.
   */
  const launch = (
    step: MachineSetupStepId,
    operation: MachineSetupOperation,
    observation: MachineSetupObservation,
    servePort: number,
    retriedWithOperator = false,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const run = yield* host.run(operation, { localPort: observation.localPort, servePort });
      const field = linkField(operation);
      if (run.url !== null && field !== null) {
        if (operation === "serve") {
          yield* Effect.logWarning(
            "Tailscale Serve is waiting for the tailnet to allow HTTPS. Approve it from Settings → Machines; setup finishes by itself.",
          );
        }
        yield* update((current) => ({
          ...current,
          working: without(current.working, step),
          [field]: run.url,
        }));
      }
      const finish = run.done.pipe(
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            if (
              outcome._tag === "failed" &&
              outcome.reason === "permission-denied" &&
              (operation === "serve" || operation === "serve-off") &&
              !retriedWithOperator &&
              (observation.host.root || observation.host.passwordlessSudo)
            ) {
              // Linux: let this user manage Serve, then try once more.
              const operator = yield* host.run("set-operator", {
                localPort: observation.localPort,
                servePort,
              });
              if ((yield* operator.done)._tag === "ok") {
                return yield* launch(step, operation, observation, servePort, true);
              }
            }
            if (outcome._tag === "ok" && operation === "serve") {
              yield* serveMode.set({
                enabled: true,
                servePort,
                localPort: observation.localPort,
              });
              yield* Effect.logInfo("Tailscale Serve now fronts this server", { servePort });
            }
            if (outcome._tag === "ok" && operation === "serve-off") {
              yield* serveMode.set({
                enabled: false,
                servePort,
                localPort: observation.localPort,
              });
              yield* Effect.logInfo("Tailscale Serve no longer fronts this server", {
                servePort,
              });
            }
            yield* update((current) => ({
              ...current,
              working: without(current.working, step),
              ...(field === null ? {} : { [field]: null }),
              handedOff:
                outcome._tag === "ok" && operation === "open-app-store"
                  ? adding(current.handedOff, step)
                  : current.handedOff,
              needsPassword:
                outcome._tag === "failed" && outcome.reason === "permission-denied"
                  ? adding(current.needsPassword, step)
                  : current.needsPassword,
              problem: outcome._tag === "ok" ? null : problemFor(step, outcome.reason),
            }));
          }),
        ),
      );
      yield* Effect.forkIn(finish, layerScope);
    });

  const runStep: MachineSetup["Service"]["runStep"] = Effect.fn("MachineSetup.runStep")(
    function* (step) {
      const observation = yield* observe;
      if (observation.progress.working.has(step)) {
        return yield* new MachineSetupError({ step, reason: "busy" });
      }
      const operation = planStep(step, observation);
      if (operation === null) {
        const current = buildMachineSetupStatus(observation, yield* DateTime.now).steps.find(
          (entry) => entry.id === step,
        );
        return yield* new MachineSetupError({
          step,
          reason: current?.state === "blocked" ? "not-ready" : "unavailable",
        });
      }
      let servePort = observation.serveMode.servePort;
      if (operation === "serve" || operation === "serve-off") {
        const choice = chooseServePort(
          observation.serveMappings ?? [],
          observation.localPort,
          observation.serveMode.servePort,
          observation.serveMode.localPort,
        );
        if (operation === "serve") {
          if (choice._tag === "none") {
            return yield* new MachineSetupError({ step, reason: "unavailable" });
          }
          servePort = choice.port;
        } else if (choice._tag === "ours") {
          // Turning off targets this server's own mapping when one is running.
          servePort = choice.port;
        }
      }
      yield* update((current) => ({
        ...current,
        working: adding(current.working, step),
        needsPassword: without(current.needsPassword, step),
        problem: null,
      }));
      yield* launch(step, operation, observation, servePort);
      return yield* status;
    },
  );

  const disableServe: MachineSetup["Service"]["disableServe"] = Effect.gen(function* () {
    const observation = yield* observe;
    if (observation.status?.backendState !== "Running") {
      // Tailscale isn't answering, so no mapping is forwarding; still save
      // the opt-out so a mapping left running is not adopted later.
      yield* serveMode.set({
        enabled: false,
        servePort: observation.serveMode.servePort,
        localPort: observation.serveMode.localPort ?? observation.localPort,
      });
      return yield* status;
    }
    return yield* runStep("disable-expose");
  }).pipe(Effect.withSpan("MachineSetup.disableServe"));

  const subscribe: MachineSetup["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first read so a change in between is not lost.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.merge(
        Stream.fromSchedule(Schedule.spaced(SUBSCRIBE_RECHECK)),
        Stream.fromSubscription(subscription),
      ).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => status),
        // Only real changes cross the wire; observedAt alone is not one.
        Stream.changesWith(
          (left, right) =>
            JSON.stringify({ ...left, observedAt: null }) ===
            JSON.stringify({ ...right, observedAt: null }),
        ),
      );
    }),
  );

  const start: MachineSetup["Service"]["start"] = Effect.fn("MachineSetup.start")(function* (port) {
    yield* Ref.set(localPort, port);
    const observation = yield* observe;
    if (!observation.serveMode.enabled || observation.status?.backendState !== "Running") return;
    const choice = chooseServePort(
      observation.serveMappings ?? [],
      port,
      observation.serveMode.servePort,
      observation.serveMode.localPort,
    );
    if (choice._tag === "ours") return;
    // `--tailscale-serve` names its port and always takes it, as it always has.
    const servePort = serveMode.explicit
      ? observation.serveMode.servePort
      : choice._tag === "free"
        ? choice.port
        : null;
    if (servePort === null) {
      yield* Effect.logWarning("Every Tailscale Serve HTTPS port serves something else");
      return;
    }
    // The saved mapping points at an earlier run's port, or was removed.
    yield* update((current) => ({ ...current, working: adding(current.working, "expose") }));
    yield* launch("expose", "serve", observation, servePort);
  });

  const lastAdoptCheck = yield* Ref.make<number | null>(null);
  const adoptServe: MachineSetup["Service"]["adoptServe"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Ref.modify(lastAdoptCheck, (last) =>
      last !== null && now - last < ADOPT_RECHECK_MS ? [false, last] : [true, now],
    );
    if (due) {
      const observation = yield* observe;
      if (!observation.serveMode.enabled) {
        yield* Effect.logWarning(
          (yield* serveMode.optedOut)
            ? "Refused a peer request forwarded by Tailscale Serve: Serve is turned off for this Cogenly. Run the Make reachable step in Settings → Machines to turn it back on."
            : "Refused a peer request forwarded by Tailscale Serve: Serve doesn't point at this server's port, or Tailscale Funnel makes it public. Open Settings → Machines to set it up.",
        );
      }
    }
    return (yield* serveMode.current).enabled;
  }).pipe(Effect.withSpan("MachineSetup.adoptServe"));

  return MachineSetup.of({ status, subscribe, runStep, disableServe, start, adoptServe });
});

export const layer = Layer.effect(MachineSetup, make);

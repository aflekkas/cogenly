import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type MachineSetupStatus, type MachineSelfReport } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as MachineSetup from "./MachineSetup.ts";
import type { MachineSetupHost } from "./machineSetupSteps.ts";
import * as TailscaleHost from "./TailscaleHost.ts";
import * as TailscaleServeMode from "./TailscaleServeMode.ts";
import type { ServePortMapping, TailscaleStatusSnapshot } from "./tailscaleState.ts";

const signedIn: TailscaleStatusSnapshot = {
  backendState: "Running",
  authUrl: null,
  magicDnsName: "hub.tail1234.ts.net",
  tailnetName: "alex@example.com",
  httpsEnabled: true,
};
const linuxWithSudo: MachineSetupHost = {
  platform: "linux",
  root: false,
  passwordlessSudo: true,
  homebrew: false,
};
const APPROVAL_URL = "https://login.tailscale.com/f/serve?node=n1";
const ours = (port = 3773): ServePortMapping => ({
  port: 443,
  target: `http://127.0.0.1:${String(port)}`,
  funnel: false,
});

interface Call {
  readonly operation: TailscaleHost.TailscaleHostOperation;
  readonly input: TailscaleHost.TailscaleRunInput;
}

/**
 * A fake machine: `probe` reads the current Tailscale state from a ref, and
 * each `run` takes the next scripted response for its operation.
 */
const makeHarness = Effect.fn(function* (options: {
  readonly host?: MachineSetupHost;
  readonly status?: TailscaleStatusSnapshot | null;
  readonly installed?: boolean;
  readonly mappings?: ReadonlyArray<ServePortMapping>;
  readonly mode?: TailscaleServeMode.TailscaleServeModeState;
  readonly runs?: Partial<
    Record<
      TailscaleHost.TailscaleHostOperation,
      ReadonlyArray<
        (input: TailscaleHost.TailscaleRunInput) => Effect.Effect<TailscaleHost.TailscaleRun>
      >
    >
  >;
}) {
  const probe = yield* Ref.make<TailscaleHost.TailscaleProbe>({
    installed: options.installed ?? true,
    version: "1.90.1",
    status: options.status === undefined ? signedIn : options.status,
    serveMappings: options.mappings ?? [],
  });
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const scripted = new Map(
    Object.entries(options.runs ?? {}).map(([operation, responses]) => [operation, [...responses]]),
  );
  const hostLayer = Layer.succeed(TailscaleHost.TailscaleHost)({
    host: Effect.succeed(options.host ?? linuxWithSudo),
    probe: Ref.get(probe),
    run: (operation, input) =>
      Ref.update(calls, (all) => [...all, { operation, input }]).pipe(
        Effect.andThen(() => {
          const next = scripted.get(operation)?.shift();
          return next === undefined ? Effect.die(`unexpected tailscale ${operation}`) : next(input);
        }),
      ),
  });
  const self: MachineSelfReport = {
    environmentId: EnvironmentId.make("env-hub"),
    name: "VPS",
    role: "cloud-server",
    hardware: "server",
    platform: "linux",
    serverVersion: "0.0.0-test",
    providers: [],
  };
  const layer = MachineSetup.layer.pipe(
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(
      TailscaleServeMode.layerMemory(options.mode ?? { enabled: false, servePort: 443 }),
    ),
    Layer.provide(
      Layer.succeed(MachineIdentity.MachineIdentity)({
        self: Effect.succeed(self),
        update: () => Effect.void,
        changes: Stream.never,
      }),
    ),
    Layer.provide(Layer.mock(ServerConfig.ServerConfig)({ port: 3773 })),
  );
  return { probe, calls, layer };
});

const finished = (outcome: TailscaleHost.TailscaleCommandOutcome = { _tag: "ok" }) =>
  Effect.succeed<TailscaleHost.TailscaleRun>({ url: null, done: Effect.succeed(outcome) });

/** The first status pushed to subscribers that satisfies `predicate`. */
const awaitStatus = (predicate: (status: MachineSetupStatus) => boolean) =>
  MachineSetup.MachineSetup.pipe(
    Effect.flatMap((setup) => setup.subscribe.pipe(Stream.filter(predicate), Stream.runHead)),
    Effect.map(Option.getOrThrow),
  );

const stepOf = (status: MachineSetupStatus, id: string) =>
  status.steps.find((step) => step.id === id)!;

describe("MachineSetup", () => {
  it.effect("adopts a Serve mapping made by hand instead of refusing its peers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mappings: [ours()] });
      yield* Effect.gen(function* () {
        const status = yield* (yield* MachineSetup.MachineSetup).status;
        assert.isTrue(status.ready);
        assert.equal(status.joinUrl, "https://hub.tail1234.ts.net/");
        const mode = yield* (yield* TailscaleServeMode.TailscaleServeMode).current;
        assert.deepEqual(mode, { enabled: true, servePort: 443, localPort: 3773 });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("surfaces the tailnet's HTTPS approval link and finishes once it is approved", () =>
    Effect.gen(function* () {
      const approved = yield* Deferred.make<TailscaleHost.TailscaleCommandOutcome>();
      const harness = yield* makeHarness({
        status: { ...signedIn, httpsEnabled: false },
        runs: {
          serve: [() => Effect.succeed({ url: APPROVAL_URL, done: Deferred.await(approved) })],
        },
      });
      yield* Effect.gen(function* () {
        const setup = yield* MachineSetup.MachineSetup;
        const started = yield* setup.runStep("expose");
        const https = stepOf(started, "enable-https");
        assert.equal(https.state, "waiting");
        assert.deepEqual(https.handoff, {
          _tag: "open-url",
          url: APPROVAL_URL,
          label: "Approve in Tailscale",
        });
        assert.isFalse(started.ready);

        // The user approves; the waiting `tailscale serve` completes by itself.
        yield* Ref.update(harness.probe, (probe) => ({
          ...probe,
          status: signedIn,
          serveMappings: [ours()],
        }));
        yield* Deferred.succeed(approved, { _tag: "ok" });
        const ready = yield* awaitStatus((status) => status.ready);
        assert.equal(ready.joinUrl, "https://hub.tail1234.ts.net/");
        assert.isNull(ready.problem);
        const [call] = yield* Ref.get(harness.calls);
        assert.deepEqual(call, { operation: "serve", input: { localPort: 3773, servePort: 443 } });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("makes this user Tailscale's operator when Serve needs root, then retries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runs: {
          serve: [
            () => finished({ _tag: "failed", reason: "permission-denied" }),
            () =>
              Ref.update(harness.probe, (probe) => ({ ...probe, serveMappings: [ours()] })).pipe(
                Effect.andThen(finished()),
              ),
          ],
          "set-operator": [() => finished()],
        },
      });
      yield* Effect.gen(function* () {
        yield* (yield* MachineSetup.MachineSetup).runStep("expose");
        yield* awaitStatus((status) => status.ready);
        const operations = (yield* Ref.get(harness.calls)).map((call) => call.operation);
        assert.deepEqual(operations, ["serve", "set-operator", "serve"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("hands the password step to a terminal when there is no passwordless sudo", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        host: { ...linuxWithSudo, passwordlessSudo: false },
        runs: { serve: [() => finished({ _tag: "failed", reason: "permission-denied" })] },
      });
      yield* Effect.gen(function* () {
        yield* (yield* MachineSetup.MachineSetup).runStep("expose");
        const status = yield* awaitStatus((status) => stepOf(status, "expose").handoff !== null);
        const expose = stepOf(status, "expose");
        assert.isNull(expose.action);
        assert.deepEqual(expose.handoff, {
          _tag: "run-command",
          command: "sudo tailscale set --operator=$USER",
          reason:
            "Run this once in a terminal on VPS. It asks for your password and lets Cogenly manage Tailscale Serve from then on.",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("starts the Tailscale sign-in and shows its link until the node is signed in", () =>
    Effect.gen(function* () {
      const signInDone = yield* Deferred.make<TailscaleHost.TailscaleCommandOutcome>();
      const harness = yield* makeHarness({
        status: { ...signedIn, backendState: "NeedsLogin", httpsEnabled: null },
        runs: {
          login: [
            () =>
              Effect.succeed({
                url: "https://login.tailscale.com/a/abc",
                done: Deferred.await(signInDone),
              }),
          ],
        },
      });
      yield* Effect.gen(function* () {
        const started = yield* (yield* MachineSetup.MachineSetup).runStep("sign-in");
        assert.equal(stepOf(started, "sign-in").state, "waiting");
        yield* Ref.update(harness.probe, (probe) => ({ ...probe, status: signedIn }));
        yield* Deferred.succeed(signInDone, { _tag: "ok" });
        const after = yield* awaitStatus((status) => stepOf(status, "sign-in").state === "done");
        assert.equal(stepOf(after, "sign-in").detail, "Signed in to alex@example.com.");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a step whose earlier steps are not done", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ installed: false, status: null });
      yield* Effect.gen(function* () {
        const error = yield* (yield* MachineSetup.MachineSetup)
          .runStep("sign-in")
          .pipe(Effect.flip);
        assert.equal(error.reason, "not-ready");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("repoints its saved mapping at this run's port, keeping the same address", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        mappings: [ours(3000)],
        mode: { enabled: true, servePort: 443, localPort: 3000 },
        runs: {
          serve: [
            (input) =>
              Ref.update(harness.probe, (probe) => ({
                ...probe,
                serveMappings: [ours(input.localPort)],
              })).pipe(Effect.andThen(finished())),
          ],
        },
      });
      yield* Effect.gen(function* () {
        yield* (yield* MachineSetup.MachineSetup).start(3773);
        const ready = yield* awaitStatus((status) => status.ready);
        assert.equal(ready.joinUrl, "https://hub.tail1234.ts.net/");
        assert.deepEqual((yield* Ref.get(harness.calls))[0]?.input, {
          localPort: 3773,
          servePort: 443,
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

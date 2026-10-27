/**
 * HealthAlerts: turns machine health into alerts on state transitions only,
 * debounced, for this machine and the machines it is paired with. Clients
 * subscribe to the snapshot; optional Slack and email channels go through
 * Cogenly integrations.
 *
 * Each evaluation feeds the engine this machine's report plus one
 * reachability item per directly paired machine, then merges in what each
 * online peer reports about itself. Only transitions this machine's engine
 * makes are delivered externally, and the peer channel serves only those, so
 * an alert is sent once and never relayed back.
 *
 * State is in memory. After a restart an ongoing problem alerts again once,
 * after the open debounce: persisting would need its own table for a case a
 * restart already makes worth a second look.
 */
import {
  MachineHealthAlertsRead,
  MachineHealthError,
  type EnvironmentId,
  type MachineHealthAlert,
  type MachineHealthAlertsSnapshot,
  type MachineHealthChannelTestResult,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import * as Integrations from "../integrations/Integrations.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HEALTH_ALERT_RESOLVED_LIMIT,
  evaluateHealthAlerts,
  healthAlertsSnapshot,
  initialHealthAlertEngineState,
  isReachabilityKey,
  type HealthObservation,
  type HealthRound,
} from "./healthAlertEngine.ts";
import {
  alertGroupMessage,
  emailSendCall,
  groupAlertsByCheck,
  slackSendCall,
  testMessage,
  type AlertMessage,
} from "./healthAlertMessages.ts";
import * as HealthAlertsState from "./HealthAlertsState.ts";
import * as MachineHealth from "./MachineHealth.ts";
import { peerReachabilityItem } from "./peerReachability.ts";

class HealthAlertDeliveryError extends Schema.TaggedError<HealthAlertDeliveryError>()(
  "HealthAlertDeliveryError",
  {
    channel: Schema.Literals(["slack", "email"]),
    reason: Schema.Literals(["no-send-tool", "integration-failed", "tool-error", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const channel = this.channel === "slack" ? "Slack" : "Email";
    switch (this.reason) {
      case "no-send-tool":
        return `${channel}: the integration has no tool for sending a message.`;
      case "integration-failed":
        return `${channel}: the integration could not be reached.`;
      case "tool-error":
        return `${channel}: the integration refused the message.`;
      case "timeout":
        return `${channel}: the integration did not answer in time.`;
    }
  }
}

export class HealthAlerts extends Context.Service<
  HealthAlerts,
  {
    readonly snapshot: Effect.Effect<MachineHealthAlertsSnapshot>;
    /** The snapshot, then again after each transition. */
    readonly subscribe: Stream.Stream<MachineHealthAlertsSnapshot>;
    /** Send a test message through each enabled external channel. */
    readonly testChannels: Effect.Effect<MachineHealthChannelTestResult, MachineHealthError>;
  }
>()("cogenly-server/health/HealthAlerts") {}

/** How often a round runs; the scheduler ticks more often and this throttles it. */
export const HEALTH_ALERT_EVALUATE_EVERY = Duration.seconds(60);
const PEER_READ_TIMEOUT = Duration.seconds(10);
const DELIVERY_TIMEOUT = Duration.seconds(30);

type Channel = "slack" | "email";

const byOpenedAt = (left: MachineHealthAlert, right: MachineHealthAlert) =>
  DateTime.toEpochMillis(right.openedAt) - DateTime.toEpochMillis(left.openedAt);
const byResolvedAt = (left: MachineHealthAlert, right: MachineHealthAlert) =>
  (right.resolvedAt === null ? 0 : DateTime.toEpochMillis(right.resolvedAt)) -
  (left.resolvedAt === null ? 0 : DateTime.toEpochMillis(left.resolvedAt));

/** This machine's alerts first, then each peer's, one per id. */
function mergeSnapshots(
  own: MachineHealthAlertsSnapshot,
  peers: Iterable<MachineHealthAlertsSnapshot>,
  self: EnvironmentId,
): MachineHealthAlertsSnapshot {
  const open = new Map<string, MachineHealthAlert>();
  const resolved = new Map<string, MachineHealthAlert>();
  for (const alert of own.open) open.set(alert.id, alert);
  for (const alert of own.recentlyResolved) resolved.set(alert.id, alert);
  for (const peer of peers) {
    // A peer's view of this machine (it saw us unreachable) is for others.
    for (const alert of peer.open)
      if (alert.originEnvironmentId !== self && !open.has(alert.id)) open.set(alert.id, alert);
    for (const alert of peer.recentlyResolved)
      if (alert.originEnvironmentId !== self && !resolved.has(alert.id))
        resolved.set(alert.id, alert);
  }
  return {
    open: [...open.values()].toSorted(byOpenedAt),
    recentlyResolved: [...resolved.values()]
      .filter((alert) => !open.has(alert.id))
      .toSorted(byResolvedAt)
      .slice(0, HEALTH_ALERT_RESOLVED_LIMIT),
  };
}

const signature = (snapshot: MachineHealthAlertsSnapshot) =>
  JSON.stringify([
    snapshot.open.map((alert) => [alert.id, alert.status, alert.title]),
    snapshot.recentlyResolved.map((alert) => alert.id),
  ]);

const make = Effect.gen(function* () {
  const health = yield* MachineHealth.MachineHealth;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const scheduler = yield* Scheduler.Scheduler;
  const integrations = yield* Integrations.Integrations;
  const settings = yield* ServerSettings.ServerSettingsService;
  const published = yield* HealthAlertsState.HealthAlertsState;

  const engine = yield* Ref.make(initialHealthAlertEngineState);
  const peerAlerts = yield* Ref.make(new Map<EnvironmentId, MachineHealthAlertsSnapshot>());
  const lastRoundAt = yield* Ref.make<number | null>(null);
  const lastSignature = yield* Ref.make(signature({ open: [], recentlyResolved: [] }));

  // Only this machine's own transitions, never what it merged from a peer.
  yield* channels.register(MachineHealthAlertsRead, () =>
    Ref.get(engine).pipe(Effect.map(healthAlertsSnapshot)),
  );

  const sendThrough = (
    channel: Channel,
    integration: string,
    recipient: string,
    message: AlertMessage,
  ) =>
    Effect.gen(function* () {
      const failed = (cause: unknown) =>
        new HealthAlertDeliveryError({ channel, reason: "integration-failed", cause });
      const { tools } = yield* integrations
        .listTools(integration, undefined)
        .pipe(Effect.mapError(failed));
      const call =
        channel === "slack"
          ? slackSendCall(tools, recipient, message.text)
          : emailSendCall(tools, recipient, message);
      if (call === null)
        return yield* new HealthAlertDeliveryError({ channel, reason: "no-send-tool" });
      const result = yield* integrations
        .callTool(integration, call.tool, call.args, undefined)
        .pipe(Effect.mapError(failed));
      if (result.isError === true)
        return yield* new HealthAlertDeliveryError({ channel, reason: "tool-error" });
    }).pipe(
      Effect.timeout(DELIVERY_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(new HealthAlertDeliveryError({ channel, reason: "timeout" })),
      }),
    );

  /** Each enabled, fully configured channel with where it sends. */
  const configuredChannels = settings.getSettings.pipe(
    Effect.map(({ health: { alertChannels } }) => {
      const { slack, email } = alertChannels;
      return {
        slack:
          slack.enabled && slack.integration !== null && slack.userId !== null
            ? { integration: slack.integration, recipient: slack.userId }
            : null,
        email:
          email.enabled && email.integration !== null && email.to !== null
            ? { integration: email.integration, recipient: email.to }
            : null,
      };
    }),
  );

  /**
   * Once per transition, one message per machine and check in a round, so
   * eighteen stuck runs send once; a failure is logged, never retried.
   */
  const deliver = (alerts: ReadonlyArray<MachineHealthAlert>, transition: "opened" | "resolved") =>
    Effect.gen(function* () {
      const message = alertGroupMessage(alerts, transition);
      if (message === null) return;
      const configured = yield* configuredChannels;
      yield* Effect.forEach(
        ["slack", "email"] as const,
        (channel) => {
          const target = configured[channel];
          return target === null
            ? Effect.void
            : sendThrough(channel, target.integration, target.recipient, message).pipe(
                Effect.catchTags({
                  HealthAlertDeliveryError: (error) =>
                    Effect.logWarning("Health alert delivery failed", {
                      channel: error.channel,
                      reason: error.reason,
                      alertIds: alerts.map((alert) => alert.id),
                      transition,
                    }),
                }),
              );
        },
        { discard: true },
      );
    }).pipe(
      Effect.catchTags({
        ServerSettingsError: () =>
          Effect.logWarning("Health alert delivery skipped: settings unavailable", {
            alertIds: alerts.map((alert) => alert.id),
          }),
      }),
    );

  const round = Effect.gen(function* () {
    const now = yield* DateTime.now;
    // `report` never fails by contract; a defect skips the round rather than
    // reading every local item as recovered.
    const report = yield* health.report.pipe(
      Effect.catchDefect(() =>
        Effect.logWarning("Health report failed; alerts not evaluated").pipe(Effect.as(null)),
      ),
    );
    if (report === null) return;
    const view = yield* machines.list;
    const self = report.environmentId;
    const paired = view.machines.filter(
      (machine) => machine.relation === "hub" || machine.relation === "spoke",
    );

    const observations: Array<HealthObservation> = [];
    const unknownChecks: Array<NonNullable<HealthRound["unknownChecks"]>[number]> = [];
    const autoFix = yield* published.autoFix;
    for (const check of report.checks) {
      if (check.status === "unknown")
        unknownChecks.push({ originEnvironmentId: self, checkId: check.id });
      for (const item of check.items) {
        // Reachability is evaluated below with the peer as its origin.
        if (isReachabilityKey(item.key)) continue;
        // Being fixed automatically: it alerts only if that fails.
        const failure = autoFix.failures.get(item.key);
        observations.push({
          originEnvironmentId: self,
          originMachineName: report.machineName,
          checkId: check.id,
          item: autoFix.holds.has(item.key)
            ? { ...item, status: "unknown" }
            : failure === undefined
              ? item
              : {
                  ...item,
                  detail: `${item.detail.trim()} Automatic fix failed: ${failure}`.trim(),
                },
        });
      }
    }
    for (const machine of paired) {
      const item = peerReachabilityItem({
        environmentId: machine.environmentId,
        name: machine.name,
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
        pairedAt: machine.pairedAt,
        pairing: machine.pairing,
        now,
      });
      if (item !== null)
        observations.push({
          originEnvironmentId: machine.environmentId,
          originMachineName: machine.name,
          checkId: "machine-links",
          item,
        });
    }

    const evaluation = evaluateHealthAlerts(
      yield* Ref.get(engine),
      { observations, unknownChecks },
      now,
    );
    yield* Ref.set(engine, evaluation.state);

    // A peer that cannot answer keeps its last snapshot until it is unpaired.
    const previousPeers = yield* Ref.get(peerAlerts);
    const nextPeers = new Map<EnvironmentId, MachineHealthAlertsSnapshot>();
    yield* Effect.forEach(
      paired,
      (machine) => {
        const kept = previousPeers.get(machine.environmentId);
        const keep = Effect.sync(() => {
          if (kept !== undefined) nextPeers.set(machine.environmentId, kept);
        });
        if (!machine.online || machine.pairing !== "paired") return keep;
        return machines.call(machine.environmentId, MachineHealthAlertsRead, {}).pipe(
          Effect.timeout(PEER_READ_TIMEOUT),
          Effect.flatMap((snapshot) =>
            Effect.sync(() => void nextPeers.set(machine.environmentId, snapshot)),
          ),
          Effect.catch(() => keep),
        );
      },
      { concurrency: 4, discard: true },
    );
    yield* Ref.set(peerAlerts, nextPeers);

    const merged = mergeSnapshots(healthAlertsSnapshot(evaluation.state), nextPeers.values(), self);
    const nextSignature = signature(merged);
    if (nextSignature !== (yield* Ref.get(lastSignature))) {
      yield* Ref.set(lastSignature, nextSignature);
      yield* published.publish(merged);
    }

    for (const group of groupAlertsByCheck(evaluation.opened)) yield* deliver(group, "opened");
    for (const group of groupAlertsByCheck(evaluation.resolved)) yield* deliver(group, "resolved");
  });

  const evaluateWhenDue = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const last = yield* Ref.get(lastRoundAt);
    if (last !== null && nowMs - last < Duration.toMillis(HEALTH_ALERT_EVALUATE_EVERY)) return;
    yield* Ref.set(lastRoundAt, nowMs);
    yield* round.pipe(
      Effect.catchTags({
        MachineError: (error) =>
          Effect.logWarning("Health alerts skipped a round: machines unavailable", {
            reason: error.reason,
          }),
      }),
    );
  });
  yield* scheduler.register("health-alerts", evaluateWhenDue);

  const thisMachineName = machines.list.pipe(
    Effect.map(
      (view) => view.machines.find((machine) => machine.relation === "this")?.name ?? "Cogenly",
    ),
    Effect.orElseSucceed(() => "Cogenly"),
  );

  const testChannels: HealthAlerts["Service"]["testChannels"] = Effect.gen(function* () {
    const configured = yield* configuredChannels.pipe(
      Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
    );
    const message = testMessage(yield* thisMachineName);
    const outcome = (
      channel: Channel,
    ): Effect.Effect<{ attempted: boolean; ok: boolean; error: string | null }> => {
      const target = configured[channel];
      return target === null
        ? Effect.succeed({ attempted: false, ok: false, error: null })
        : sendThrough(channel, target.integration, target.recipient, message).pipe(
            Effect.as({ attempted: true, ok: true, error: null }),
            Effect.catchTags({
              HealthAlertDeliveryError: (error) =>
                Effect.succeed({ attempted: true, ok: false, error: error.message }),
            }),
          );
    };
    return yield* Effect.all(
      { slack: outcome("slack"), email: outcome("email") },
      { concurrency: "unbounded" },
    );
  });

  return HealthAlerts.of({
    snapshot: published.current,
    subscribe: published.changes,
    testChannels,
  });
});

export const layer = Layer.effect(HealthAlerts, make);

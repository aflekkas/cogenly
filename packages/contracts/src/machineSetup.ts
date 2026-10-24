import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Getting a machine ready to pair: Tailscale gives the user's machines a
 * private, encrypted link, and Tailscale Serve puts this Cogenly on it over
 * HTTPS. Each step is either done for the user or handed off with one precise
 * action. See apps/server/src/tailscale/MachineSetup.ts.
 */

export const MachineSetupStepId = Schema.Literals([
  "install",
  "start",
  "sign-in",
  "enable-https",
  "expose",
  // The way back out of "expose": removes this server's Serve mapping and
  // saves Serve as off. Not a checklist row; the checklist shows it as the
  // "expose" step becoming available again.
  "disable-expose",
]);
export type MachineSetupStepId = typeof MachineSetupStepId.Type;

/**
 * "todo": the step's action is available. "working": Cogenly is doing it now.
 * "waiting": done on Cogenly's side and waiting on the user, such as a sign-in
 * page they have open; it finishes by itself. "blocked": an earlier step comes
 * first.
 */
export const MachineSetupStepState = Schema.Literals([
  "done",
  "todo",
  "working",
  "waiting",
  "blocked",
]);
export type MachineSetupStepState = typeof MachineSetupStepState.Type;

/**
 * What the user does for a step Cogenly cannot finish alone. A URL opens in
 * the client's browser. A command runs in a terminal on the machine being set
 * up, for steps that need the user's password; Cogenly never asks for it.
 */
export const MachineSetupHandoff = Schema.Union([
  Schema.TaggedStruct("open-url", {
    url: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("run-command", {
    command: TrimmedNonEmptyString,
    /** Why it has to run in a terminal, such as "It asks for your password." */
    reason: TrimmedNonEmptyString,
  }),
]);
export type MachineSetupHandoff = typeof MachineSetupHandoff.Type;

export const MachineSetupStep = Schema.Struct({
  id: MachineSetupStepId,
  state: MachineSetupStepState,
  /** Plain-language name of the step, such as "Sign in to Tailscale". */
  title: Schema.String,
  /** One sentence about where it stands or what happens next. */
  detail: Schema.String,
  /**
   * The button label when Cogenly can do the step itself on this machine.
   * Null when the step is done, blocked, or only a handoff remains.
   */
  action: Schema.NullOr(Schema.String),
  /** Present alongside or instead of `action` when the user has a part. */
  handoff: Schema.NullOr(MachineSetupHandoff),
});
export type MachineSetupStep = typeof MachineSetupStep.Type;

export const MachineTailscaleState = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** The daemon answers and is connected, not stopped. */
  running: Schema.Boolean,
  signedIn: Schema.Boolean,
  tailnetName: Schema.NullOr(Schema.String),
  /** This machine's MagicDNS name, such as `laptop.tail1234.ts.net`. */
  magicDnsName: Schema.NullOr(Schema.String),
  /** Whether the tailnet allows HTTPS certificates, which Serve needs. Null when unknown. */
  httpsEnabled: Schema.NullOr(Schema.Boolean),
  /** Tailscale Serve fronts this server, and Cogenly accepts what it forwards. */
  served: Schema.Boolean,
  /** The HTTPS port Serve uses for this server. */
  servePort: Schema.Number,
});
export type MachineTailscaleState = typeof MachineTailscaleState.Type;

export const MachineSetupStatus = Schema.Struct({
  observedAt: Schema.DateTimeUtc,
  platform: Schema.String,
  tailscale: MachineTailscaleState,
  steps: Schema.Array(MachineSetupStep),
  /** Every step is done: other machines can pair with this one. */
  ready: Schema.Boolean,
  /** The private HTTPS address other machines reach this one on, once served. */
  joinUrl: Schema.NullOr(Schema.String),
  /** The last step that failed, in plain language, until it is retried. */
  problem: Schema.NullOr(Schema.String),
});
export type MachineSetupStatus = typeof MachineSetupStatus.Type;

export const MachineSetupRunStepInput = Schema.Struct({ step: MachineSetupStepId });
export type MachineSetupRunStepInput = typeof MachineSetupRunStepInput.Type;

export class MachineSetupError extends Schema.TaggedError<MachineSetupError>()(
  "MachineSetupError",
  {
    step: Schema.NullOr(MachineSetupStepId),
    reason: Schema.Literals(["unavailable", "not-ready", "busy"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Cogenly can't do this step itself on this machine. Follow the step's instructions instead.";
      case "not-ready":
        return "Finish the earlier steps first.";
      case "busy":
        return "Cogenly is already working on this step.";
    }
  }
}

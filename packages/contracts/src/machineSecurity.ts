import * as Schema from "effect/Schema";

/**
 * Read-only security posture of the machine this server runs on.
 * Never green without evidence: a check that could not run is `unknown`,
 * and `private_verified` requires every applicable check to have passed
 * with evidence. See apps/server/src/security/MachineSecurity.ts.
 */

export const MachineSecurityState = Schema.Literals([
  "private_verified",
  "attention",
  "incomplete",
  "unknown",
]);
export type MachineSecurityState = typeof MachineSecurityState.Type;

export const MachineSecurityCheckId = Schema.Literals([
  "cogenly-bind",
  "listening-sockets",
  "sshd",
  "tailscale",
  "firewall",
]);
export type MachineSecurityCheckId = typeof MachineSecurityCheckId.Type;

export const MachineSecurityFindingStatus = Schema.Literals(["pass", "warn", "fail", "unknown"]);
export type MachineSecurityFindingStatus = typeof MachineSecurityFindingStatus.Type;

export const MachineSecurityFinding = Schema.Struct({
  checkId: MachineSecurityCheckId,
  status: MachineSecurityFindingStatus,
  title: Schema.String,
  detail: Schema.String,
  /** What the observation was based on, e.g. the command or config value seen. */
  evidence: Schema.String,
});
export type MachineSecurityFinding = typeof MachineSecurityFinding.Type;

export const MachineSecurityListeningSocket = Schema.Struct({
  address: Schema.String,
  port: Schema.Number,
  process: Schema.NullOr(Schema.String),
  loopback: Schema.Boolean,
});
export type MachineSecurityListeningSocket = typeof MachineSecurityListeningSocket.Type;

export const MachineSecurityStatus = Schema.Struct({
  state: MachineSecurityState,
  observedAt: Schema.DateTimeUtc,
  platform: Schema.String,
  cogenlyBind: Schema.Struct({
    host: Schema.String,
    port: Schema.Number,
    loopback: Schema.Boolean,
  }),
  listeningSockets: Schema.Array(MachineSecurityListeningSocket),
  findings: Schema.Array(MachineSecurityFinding),
  /** One-line human summary of the state. */
  summary: Schema.String,
});
export type MachineSecurityStatus = typeof MachineSecurityStatus.Type;

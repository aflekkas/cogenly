import type {
  MachineInfo,
  MachineKind,
  MachineRelation,
  MachineSelfReport,
} from "@cogenly/contracts";
import type * as DateTime from "effect/DateTime";

const kindFor = (role: MachineSelfReport["role"], relation: MachineRelation): MachineKind =>
  role === "cloud-server"
    ? "cloud-server"
    : relation === "this"
      ? "this-computer"
      : "other-computer";

/** A machine as the server answering sees it. */
export function toMachineInfo(
  report: MachineSelfReport,
  input: {
    readonly relation: MachineRelation;
    readonly online: boolean;
    readonly lastSeenAt: DateTime.Utc | null;
    readonly pairedAt: DateTime.Utc | null;
    readonly pairing: MachineInfo["pairing"];
  },
): MachineInfo {
  return {
    environmentId: report.environmentId,
    name: report.name,
    kind: kindFor(report.role, input.relation),
    hardware: report.hardware,
    platform: report.platform,
    relation: input.relation,
    online: input.online,
    lastSeenAt: input.lastSeenAt,
    pairedAt: input.pairedAt,
    pairing: input.pairing,
    providers: report.providers,
  };
}

/**
 * Re-relate a machine from the hub's point of view to a spoke's: the hub's
 * "this" becomes "hub", its other spokes become "peer".
 */
export function relateHubMachine(machine: MachineInfo): MachineInfo {
  const relation: MachineRelation = machine.relation === "this" ? "hub" : "peer";
  return {
    ...machine,
    relation,
    kind: machine.kind === "this-computer" ? "other-computer" : machine.kind,
    pairing: machine.pairing === "self" ? "paired" : machine.pairing,
  };
}

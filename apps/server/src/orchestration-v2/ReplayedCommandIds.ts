import { isT3ImportCommandId } from "../t3Import/T3ImportCommandIds.ts";

/**
 * Command ids of events copied from the paired machine that owns the thread.
 * The owner already reacted to them (started work, settled, notified); a
 * replica only records what happened there.
 */
export const REPLICA_COMMAND_PREFIX = "command:replica:";

export const isReplicaCommandId = (commandId: string | null | undefined): boolean =>
  typeof commandId === "string" && commandId.startsWith(REPLICA_COMMAND_PREFIX);

/**
 * Events recording activity that happened somewhere else: a T3 import or a
 * paired machine's thread. Anything that starts work, notifies, or wakes a
 * thread from domain events must skip these.
 */
export const isReplayedCommandId = (commandId: string | null | undefined): boolean =>
  isT3ImportCommandId(commandId) || isReplicaCommandId(commandId);

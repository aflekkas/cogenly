/**
 * Command ids of events written by Import from T3 Code.
 *
 * Imported history replays runs completing, PRs syncing and messages arriving
 * that happened in T3 long ago. Anything that reacts to new activity (queue
 * promotion, agent triggers, settlement, PR sync, notifications) must skip
 * these events, or the import would start agents and notify per thread.
 */
export const T3_IMPORT_COMMAND_PREFIX = "command:t3-import:";

export const isT3ImportCommandId = (commandId: string | null | undefined): boolean =>
  typeof commandId === "string" && commandId.startsWith(T3_IMPORT_COMMAND_PREFIX);

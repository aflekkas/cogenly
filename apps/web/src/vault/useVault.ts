import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  VaultCreateInput,
  VaultItemId,
  VaultItemMetadata,
  VaultUpdateInput,
  VaultUsageEntry,
} from "@cogenly/contracts";

import { toastManager } from "../components/ui/toast";
import { vaultRpc } from "../rpc/vault";
import { useEnvironmentQuery } from "../state/query";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

const EMPTY_ITEMS: ReadonlyArray<VaultItemMetadata> = [];
const EMPTY_USAGE: ReadonlyArray<VaultUsageEntry> = [];

/** Every item in one environment, across scopes. */
export function useVaultItems(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : vaultRpc.list({ environmentId, input: {} }),
  );
  return {
    items: query.data?.items ?? EMPTY_ITEMS,
    error: query.error,
    isLoaded: query.data !== null,
    refresh: query.refresh,
  };
}

/** Newest-first usage, for one item or the whole vault. */
export function useVaultUsage(environmentId: EnvironmentId | null, itemId?: VaultItemId) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : vaultRpc.usage({
          environmentId,
          input: { limit: itemId ? 100 : 500, ...(itemId ? { itemId } : {}) },
        }),
  );
  return {
    usage: query.data?.usage ?? EMPTY_USAGE,
    error: query.error,
    isLoaded: query.data !== null,
    refresh: query.refresh,
  };
}

function settled<A, E>(title: string, result: AtomCommandResult<A, E>): A | null {
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return null;
}

/**
 * Create, update and delete items. Each resolves to its result, or null after
 * reporting a failure, then calls `onChanged` so open lists re-read.
 */
export function useVaultActions(environmentId: EnvironmentId | null, onChanged?: () => void) {
  const canWrite = useAtomValue(vaultRpc.create.permissionAtom(environmentId));
  const create = useOrchestrationCommand(vaultRpc.create, { reportFailure: false });
  const update = useOrchestrationCommand(vaultRpc.update, { reportFailure: false });
  const remove = useOrchestrationCommand(vaultRpc.remove, { reportFailure: false });
  const done = <A>(value: A | null) => {
    if (value !== null) onChanged?.();
    return value;
  };
  return {
    canWrite: environmentId !== null && canWrite,
    create: async (input: VaultCreateInput) =>
      environmentId === null
        ? null
        : (done(settled("Could not save this item", await create({ environmentId, input })))
            ?.item ?? null),
    update: async (input: VaultUpdateInput) =>
      environmentId === null
        ? null
        : (done(settled("Could not save this item", await update({ environmentId, input })))
            ?.item ?? null),
    remove: async (id: VaultItemId) =>
      environmentId === null
        ? null
        : done(
            settled("Could not delete this item", await remove({ environmentId, input: { id } })),
          ),
  };
}

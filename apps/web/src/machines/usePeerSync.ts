import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SharedDocumentKind, SharedSyncPeerStatus } from "@t3tools/contracts";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { syncRpc } from "../rpc/sync";
import { useEnvironmentQuery } from "../state/query";

const EMPTY_PEERS: ReadonlyArray<SharedSyncPeerStatus> = [];

/**
 * The machines directly paired with an environment and what each has yet to
 * receive of `kind`. Re-reads when pairing or presence changes, and when the
 * window comes back, since shared-document changes are not pushed to clients.
 * Empty for a standalone machine or a connection that cannot read it.
 */
export function useSyncPeers(environmentId: EnvironmentId | null, kind: SharedDocumentKind) {
  const canRead = useAtomValue(syncRpc.status.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId === null || !canRead
      ? null
      : syncRpc.status({ environmentId, input: { kinds: [kind] } }),
  );
  useLiveRefresh(query.refresh, {
    enabled: environmentId !== null && canRead,
    key: `sync-status:${environmentId}:${kind}`,
  });
  return {
    peers: query.data?.peers ?? EMPTY_PEERS,
    isLoaded: query.data !== null,
    refresh: query.refresh,
  };
}

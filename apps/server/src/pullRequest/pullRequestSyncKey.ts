import {
  pullRequestHostOf,
  type PullRequestRef,
  type RepositoryIdentity,
  SourceControlProviderKind,
  type ThreadPullRequestKey,
} from "@cogenly/contracts";
import { normalizeThreadPullRequestKey } from "@cogenly/shared/threadPullRequests";

/** Convert checkout-scoped references to the host-level identity used by linked threads. */
export function pullRequestSyncKey(
  reference: PullRequestRef,
  identity?: RepositoryIdentity | null,
): ThreadPullRequestKey | null {
  const host =
    reference.host ??
    (identity
      ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
      : undefined);
  return host === undefined
    ? null
    : normalizeThreadPullRequestKey({
        host,
        repository: reference.repository,
        number: reference.number,
      });
}

import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

/**
 * What a client knows about one scope on one environment. Gates that render a
 * message must tell "not known yet" apart from "denied": the session fetch
 * waits for the environment's connection, so an environment that is still
 * connecting reads as `pending`, not as a denial.
 */
export type ScopeAccess = "granted" | "denied" | "pending" | "unreachable";

/**
 * A resolved session (also while it revalidates) answers the scope; nothing
 * fetched yet is `pending`; a failed fetch is `pending` while it retries and
 * `unreachable` after. A failure never falls back to the scopes cached from an
 * earlier success, so a revoked credential stops granting.
 */
export function resolveScopeAccess(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): ScopeAccess {
  switch (result._tag) {
    case "Initial":
      return "pending";
    case "Success":
      return sessionGrantsScope(result.value, scope) ? "granted" : "denied";
    case "Failure":
      return result.waiting ? "pending" : "unreachable";
  }
}

/** The boolean view every action gate uses: only a confirmed grant allows. */
export function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  return resolveScopeAccess(result, scope) === "granted";
}

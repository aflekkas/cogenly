import {
  isIntegrationError,
  type Integration,
  type IntegrationError,
  type IntegrationScope,
  type IntegrationSummary,
  type IntegrationTestResult,
} from "@cogenly/contracts";

const REASON_TEXT: Readonly<Record<IntegrationError["reason"], string>> = {
  google_client_missing: "Ask an agent to configure your Google OAuth client.",
  local_runtime_missing:
    "uv isn't installed on the machine running Cogenly. Install it, then try again.",
  storage: "Cogenly could not read or save this integration.",
  not_found: "This integration no longer exists.",
  conflict: "Another integration already uses this name.",
  disabled: "Turn the integration on to test it.",
  credential_unresolved: "A vault reference in the headers does not match a vault item.",
  credential_not_allowed:
    "A vault item in the headers doesn't allow this server. Save the integration to approve it, or add the server to the item's allowed domains.",
  upstream_unreachable: "The server could not be reached.",
  upstream_timeout: "The server took too long to answer.",
  upstream_error: "The server answered with an error.",
  invalid_request: "The server rejected the request.",
  approval_required: "Widening project access needs owner approval.",
  scope_missing:
    "The grant is missing a required scope. Reconnect to approve the needed permissions.",
  sign_in_required: "Sign in to this service to use it.",
  client_id_required:
    "This service needs an app of your own. Add the app's client ID and secret, then sign in.",
};

/** Plain text for a failed integrations RPC. */
export function integrationErrorText(error: unknown): string {
  if (isIntegrationError(error))
    return error.oauthFailure ? error.message : REASON_TEXT[error.reason];
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The server rejected the change.";
}

/** The server words a failed test as "Could not connect (<reason>)."; this makes it plain. */
export function testResultReason(result: IntegrationTestResult): string | null {
  if (result.status === "connected") return null;
  const token = /\(([a-z_]+)\)/.exec(result.message)?.[1];
  return token !== undefined && token in REASON_TEXT
    ? REASON_TEXT[token as IntegrationError["reason"]]
    : result.message;
}

export interface IntegrationStatusView {
  readonly tone: "success" | "error" | "warning" | "neutral";
  readonly label: string;
  readonly reason: string | null;
  readonly toolCount: number | null;
  /** When the server last heard from the upstream, if it has. */
  readonly checkedAt?: string;
}

/** "Linear · Spawn Partners": how two accounts of one service read apart. */
export function integrationTitle(integration: Integration): string {
  const account = integration.accountLabel?.trim();
  return account ? `${integration.displayName} · ${account}` : integration.displayName;
}

/** A test from this page, tied to the integration version it ran against. */
export interface IntegrationTest {
  readonly updatedAt: string;
  readonly result: IntegrationTestResult;
}

/**
 * What a row shows: Connected, Needs sign-in (Sign in on this machine for an
 * account synced from another one), Error, or Off, worded like the composer's
 * Sources badges. Tests belong to one integration version and expire when a
 * subscription reports a newer server outcome. Both timestamps use the server
 * clock, so a client's clock cannot keep an old result alive.
 */
export function integrationStatus(
  summary: IntegrationSummary,
  lastTest: IntegrationTest | undefined,
): IntegrationStatusView {
  if (!summary.integration.enabled) {
    return { tone: "neutral", label: "Off", reason: null, toolCount: null };
  }
  const checked = summary.checkedAt === undefined ? {} : { checkedAt: summary.checkedAt };
  // A failed managed process says more than any test of it.
  const managed = summary.managed;
  if (managed?.state === "failed" || managed?.state === "missing_runtime") {
    return {
      tone: "error",
      label: "Error",
      reason: summary.message ?? managed.message ?? (managed.stderrTail || null),
      toolCount: null,
    };
  }
  // The server knows a sign-in is missing better than any earlier test does.
  if (summary.status === "needs_sign_in") {
    return {
      tone: "warning",
      label: summary.syncedFrom === undefined ? "Needs sign-in" : "Sign in on this machine",
      reason: summary.message ?? null,
      toolCount: null,
      ...checked,
    };
  }
  if (managed?.state === "starting" || managed?.state === "stopped") {
    const label = managed.state === "starting" ? "Starting" : "Stopped";
    return { tone: "neutral", label, reason: null, toolCount: null };
  }
  const test =
    lastTest?.updatedAt === summary.integration.updatedAt &&
    (summary.checkedAt === undefined ||
      (lastTest.result.checkedAt !== undefined && lastTest.result.checkedAt > summary.checkedAt))
      ? lastTest.result
      : undefined;
  if (test !== undefined) {
    return test.status === "connected"
      ? { tone: "success", label: "Connected", reason: null, toolCount: test.toolCount }
      : { tone: "error", label: "Error", reason: testResultReason(test), toolCount: null };
  }
  if (summary.status === "error") {
    return {
      tone: "error",
      label: "Error",
      reason: summary.message ?? null,
      toolCount: null,
      ...checked,
    };
  }
  if (summary.status === "connected") {
    return {
      tone: "success",
      label: "Connected",
      reason: null,
      toolCount: summary.toolCount,
      ...checked,
    };
  }
  return { tone: "neutral", label: "Not checked", reason: null, toolCount: null };
}

export function scopeLabel(
  scope: IntegrationScope,
  labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string {
  if (scope.type === "all") return "All projects";
  const names = scope.labelIds.flatMap((id) => {
    const label = labels.find((candidate) => candidate.id === id);
    return label ? [label.name] : [];
  });
  if (names.length === 0) return "No projects";
  return names.join(", ");
}

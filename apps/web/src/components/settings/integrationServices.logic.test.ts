import {
  IntegrationError,
  INTEGRATION_CATALOG,
  type Integration,
  type IntegrationSummary,
  type ProjectLabelId,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

const errorCodec = Schema.fromJsonString(IntegrationError);
const encodeError = Schema.encodeSync(errorCodec);
const decodeError = Schema.decodeUnknownSync(errorCodec);

import {
  integrationErrorText,
  integrationSignInView,
  settleIntegrationAction,
  type IntegrationActionState,
  integrationStatus,
  integrationTitle,
  scopeLabel,
  testResultReason,
} from "./integrationServices.logic";

const integration = {
  id: "integration:1",
  name: "gmail",
  displayName: "Gmail",
  transport: "http",
  url: "https://mcp.example.com/gmail",
  headers: { Authorization: "Bearer {{credential:gmail.password}}" },
  enabled: true,
  scope: { type: "all" },
  hint: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
} as unknown as Integration;

const summary = (overrides: Partial<IntegrationSummary> = {}): IntegrationSummary => ({
  integration,
  status: "unknown",
  toolCount: null,
  ...overrides,
});

describe("integrationStatus", () => {
  it.each(["connected", "error"] as const)(
    "expires an old test when the server reports %s later",
    (status) => {
      const view = integrationStatus(
        summary({
          status,
          toolCount: 7,
          message: "Latest server failure",
          checkedAt: "2026-10-01T00:00:02.000Z",
        }),
        {
          updatedAt: integration.updatedAt,
          result: {
            status: status === "connected" ? "disconnected" : "connected",
            toolCount: 2,
            message: "Old test",
            checkedAt: "2026-10-01T00:00:01.000Z",
          },
        },
      );
      expect(view.label).toBe(status === "connected" ? "Connected" : "Failing");
      expect(view.toolCount).toBe(status === "connected" ? 7 : null);
      expect(view.reason).toBe(status === "error" ? "Latest server failure" : null);
    },
  );

  const failed = {
    updatedAt: integration.updatedAt,
    result: {
      status: "disconnected" as const,
      toolCount: 0,
      message: "Could not connect (upstream_timeout).",
    },
  };

  it("prefers off, then a test of this version, then cached tools", () => {
    expect(
      integrationStatus(summary({ integration: { ...integration, enabled: false } }), failed),
    ).toMatchObject({ label: "Off", tone: "neutral" });
    expect(integrationStatus(summary({ status: "connected", toolCount: 4 }), failed)).toMatchObject(
      { tone: "error", reason: "The server took too long to answer." },
    );
    expect(
      integrationStatus(summary(), {
        updatedAt: integration.updatedAt,
        result: { status: "connected", toolCount: 1, message: "" },
      }),
    ).toEqual({ tone: "success", label: "Connected", reason: null, toolCount: 1 });
    expect(integrationStatus(summary({ status: "connected", toolCount: 4 }), undefined)).toEqual({
      tone: "success",
      label: "Connected",
      reason: null,
      toolCount: 4,
    });
    expect(integrationStatus(summary(), undefined)).toMatchObject({ label: "Not checked" });
  });

  it("shows a missing sign-in over any test, and the server's error with when it checked", () => {
    const oauth = { ...integration, auth: { type: "oauth" as const } };
    const needs = summary({
      integration: oauth,
      status: "needs_sign_in",
      message: "The sign-in was revoked or expired. Sign in again.",
    });
    expect(integrationStatus(needs, failed)).toMatchObject({
      tone: "warning",
      label: "Needs sign-in",
      reason: "The sign-in was revoked or expired. Sign in again.",
    });
    expect(
      integrationStatus(
        summary({
          status: "error",
          message: "The server could not be reached.",
          checkedAt: "2026-10-01T00:00:00.000Z" as IntegrationSummary["checkedAt"] & string,
        }),
        undefined,
      ),
    ).toEqual({
      tone: "error",
      label: "Failing",
      reason: "The server could not be reached.",
      toolCount: null,
      checkedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("drops a test once the integration changes", () => {
    expect(
      integrationStatus(summary(), { ...failed, updatedAt: "2026-09-01T00:00:00.000Z" }),
    ).toMatchObject({ label: "Not checked" });
  });

  it("words RPC failures plainly", () => {
    expect(
      integrationErrorText(new IntegrationError({ operation: "create", reason: "conflict" })),
    ).toBe("Another integration already uses this name.");
    expect(integrationErrorText(new Error("Socket closed"))).toBe("Socket closed");
    expect(integrationErrorText(undefined)).toBe("The server rejected the change.");
  });

  it("keeps an unrecognised failure message as written", () => {
    expect(
      testResultReason({ status: "disconnected", toolCount: 0, message: "Something odd" }),
    ).toBe("Something odd");
  });

  it("words a failed test from its reason code, never the raw code", () => {
    expect(
      testResultReason({
        status: "disconnected",
        toolCount: 0,
        reason: "sign_in_required",
        message: "Could not connect (sign_in_required).",
      }),
    ).toBe("Sign in to this service to use it.");
    expect(
      testResultReason({
        status: "disconnected",
        toolCount: 0,
        message: "Could not connect (scope_missing).",
      }),
    ).toBe("The grant is missing a required scope. Reconnect to approve the needed permissions.");
  });
});

describe("display helpers", () => {
  it("shows current process health ahead of a stale successful connection test", () => {
    const runningTest = {
      updatedAt: integration.updatedAt,
      result: { status: "connected" as const, toolCount: 1, message: "" },
    };
    expect(
      integrationStatus(
        summary({ managed: { state: "failed", version: "2.1.2", stderrTail: "Process exited" } }),
        runningTest,
      ),
    ).toMatchObject({ label: "Failing", tone: "error", reason: "Process exited" });
    expect(
      integrationStatus(
        summary({ managed: { state: "starting", version: "2.1.2", stderrTail: "" } }),
        undefined,
      ),
    ).toMatchObject({ label: "Starting" });
    // A managed Google account without a grant signs in like a remote OAuth one.
    const google = summary({
      integration: { ...integration, transport: "local", headers: {} },
      status: "needs_sign_in",
      managed: { state: "running", version: "2.1.2", stderrTail: "" },
    });
    expect(integrationStatus(google, runningTest)).toMatchObject({ label: "Needs sign-in" });
    // An account synced from another machine signs in here separately.
    expect(
      integrationStatus({ ...google, syncedFrom: { machineLabel: "Mac mini" } }, runningTest),
    ).toMatchObject({ label: "Sign in on this machine", tone: "warning" });
  });
  it("shows a host and a scope", () => {
    const labels = [{ id: "a", name: "Cogenly" }];
    expect(scopeLabel({ type: "all" }, labels)).toBe("All projects");
    expect(
      scopeLabel(
        { type: "projects", labelIds: ["a", "gone"] as unknown as ProjectLabelId[] },
        labels,
      ),
    ).toBe("Cogenly");
  });
  it("names the account only when it adds something to the service's name", () => {
    expect(integrationTitle({ ...integration, accountLabel: "Spawn Partners" })).toBe(
      "Gmail · Spawn Partners",
    );
    expect(integrationTitle({ ...integration, accountLabel: " gmail " })).toBe("Gmail");
    expect(integrationTitle(integration)).toBe("Gmail");
  });
});

describe("integration sign-in state", () => {
  it("a failure atomically replaces pending, and settling cannot erase it", () => {
    let state: IntegrationActionState = { type: "pending" };
    expect(integrationSignInView(state, integration)).toMatchObject({
      label: "Opening sign-in…",
      disabled: true,
      error: null,
    });
    state = { type: "error", message: "OAuth authorize failed" };
    expect(integrationSignInView(state, integration)).toMatchObject({
      label: "Retry",
      disabled: false,
      error: "OAuth authorize failed",
    });
    expect(settleIntegrationAction(state)).toBe(state);
    expect(
      integrationSignInView({ type: "pending", purpose: "change" }, integration),
    ).toMatchObject({ label: "Sign in", disabled: true, error: null });
    expect(
      integrationSignInView({ type: "pending" }, integration, { message: "An earlier failure" })
        .error,
    ).toBeNull();
    expect(integrationSignInView({ type: "idle" }, integration, { connected: true })).toMatchObject(
      { label: "Connected", disabled: true },
    );
  });

  it("catalog cards and Settings never offer server, client ID or scope inputs", () => {
    for (const entry of INTEGRATION_CATALOG) {
      const account = {
        ...integration,
        url: entry.kind === "remote" ? entry.url : integration.url,
        auth: { type: "oauth" as const },
      };
      for (const state of [
        { type: "idle" },
        { type: "pending" },
        { type: "error", message: "Try again" },
      ] satisfies IntegrationActionState[]) {
        // The card knows its catalog ID even before its account arrives.
        expect(integrationSignInView(state, undefined, { catalogId: entry.id })).toMatchObject({
          showServerUrl: false,
          showClientId: false,
          showOAuthScopes: false,
        });
        if (entry.kind === "remote")
          expect(integrationSignInView(state, account)).toMatchObject({
            showServerUrl: false,
            showClientId: false,
            showOAuthScopes: false,
          });
      }
    }
    expect(
      integrationSignInView({ type: "idle" }, { ...integration, auth: { type: "oauth" } }),
    ).toMatchObject({ showServerUrl: true, showClientId: true, showOAuthScopes: true });
  });

  it("shows bounded OAuth detail carried through the error cause", () => {
    const error = new IntegrationError({
      operation: "sign in",
      reason: "upstream_error",
      cause: {
        stage: "authorize",
        host: "auth.example",
        status: 400,
        error: "invalid_client",
        description: "Client expired",
      },
    });
    const received = decodeError(encodeError(error));
    expect(received.cause).toMatchObject({ stage: "authorize", host: "auth.example", status: 400 });
    expect(integrationErrorText(received)).toBe(
      "OAuth authorize failed at auth.example (HTTP 400): invalid_client (Client expired).",
    );
  });
});

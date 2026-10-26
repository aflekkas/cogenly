import { describe, expect, it } from "vite-plus/test";
import {
  IntegrationId,
  integrationCatalogEntry,
  type IntegrationCatalogId,
  type IntegrationSetupAction,
} from "@cogenly/contracts";

import {
  GOOGLE_SCOPES,
  agentFailureMessage,
  agentNextStep,
  catalogSetupFor,
  setupActionFor,
} from "./IntegrationSetup.ts";

const entry = (id: IntegrationCatalogId) => integrationCatalogEntry(id)!;
const account = (auth?: { clientId: string; clientSecret: string }) => ({
  id: IntegrationId.make("integration:1"),
  displayName: "Slack",
  accountLabel: "Acme",
  headers: {},
  ...(auth === undefined ? {} : { auth: { type: "oauth" as const, ...auth } }),
});
const steps = (action: IntegrationSetupAction | undefined) =>
  action?.type === "oauth_client" ? action.steps : [];

describe("setupActionFor, per service", () => {
  it("guides Google's own client through each console page, with the values to paste", () => {
    const action = setupActionFor({
      entry: entry("google-workspace"),
      reason: "google_client_missing",
      redirectUri: "https://cogenly.example.com/oauth/integrations/google/callback",
    });
    expect(action).toMatchObject({ type: "oauth_client", catalogId: "google-workspace" });
    const urls = steps(action).map((step) => step.url);
    expect(urls).toContain("https://console.cloud.google.com/projectcreate");
    expect(urls.find((url) => url?.includes("flows/enableapi"))).toContain(
      "gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com",
    );
    expect(urls).toContain("https://console.cloud.google.com/auth/audience");
    expect(urls).toContain("https://console.cloud.google.com/auth/clients/create");
    expect(steps(action).find((step) => step.url?.endsWith("/auth/audience"))?.text).toContain(
      "In production",
    );
    const copies = Object.fromEntries(
      steps(action).flatMap((step) => (step.copy ? [[step.copy.label, step.copy.value]] : [])),
    );
    expect(copies).toEqual({
      Scopes: GOOGLE_SCOPES.join(" "),
      "Authorized redirect URI": "https://cogenly.example.com/oauth/integrations/google/callback",
    });
  });

  it("guides Slack through an app made from Cogenly's manifest", () => {
    const action = catalogSetupFor({
      entry: entry("slack"),
      mode: "oauth_app",
      redirectUri: "https://cogenly.example.com/oauth/integrations/callback",
    });
    expect(action).toMatchObject({ type: "oauth_client", title: "Create your Slack app" });
    expect(steps(action)[0]?.copy?.value).toContain(
      '"https://cogenly.example.com/oauth/integrations/callback"',
    );
    expect(steps(action).map((step) => step.url)).toContain("https://api.slack.com/apps?new_app=1");
    // Slack refuses plain-http redirect URLs, so the step says to use the HTTPS address.
    expect(
      catalogSetupFor({
        entry: entry("slack"),
        mode: "oauth_app",
        redirectUri: "http://localhost:3773/oauth/integrations/callback",
      })?.message,
    ).toContain("https address");
  });

  it("offers GitHub a token by default and its own OAuth app as the alternative", () => {
    expect(catalogSetupFor({ entry: entry("github"), mode: "api_key" })).toMatchObject({
      type: "api_key",
      label: "Personal access token",
      url: "https://github.com/settings/personal-access-tokens/new",
    });
    const app = catalogSetupFor({
      entry: entry("github"),
      mode: "oauth_app",
      redirectUri: "https://cogenly.example.com/oauth/integrations/callback",
    });
    expect(steps(app).map((step) => step.copy?.value)).toContain(
      "https://cogenly.example.com/oauth/integrations/callback",
    );
  });

  it("signs in to services that register Cogenly themselves in one click", () => {
    for (const id of ["linear", "notion", "wispr-flow", "fathom"] as const) {
      expect(catalogSetupFor({ entry: entry(id), mode: "oauth" })).toBeUndefined();
      expect(
        setupActionFor({
          entry: entry(id),
          integration: { ...account(), displayName: entry(id).name },
          status: "needs_sign_in",
        }),
      ).toMatchObject({
        type: "sign_in",
        integrationId: "integration:1",
        title: `Sign in to ${entry(id).name}`,
      });
    }
    expect(catalogSetupFor({ entry: entry("linear"), mode: "api_key" })).toMatchObject({
      url: "https://linear.app/settings/account/security",
    });
  });
});

describe("custom server setup", () => {
  it("turns missing manual clients and missing secrets into the same inline form", () => {
    for (const reason of [
      "client_id_required",
      "credential_unresolved",
      "credential_not_allowed",
    ] as const) {
      const action = setupActionFor({
        entry: undefined,
        integration: account({ clientId: "custom", clientSecret: "{{credential:custom.value}}" }),
        status: "needs_sign_in",
        reason,
        redirectUri: "https://cogenly.example.com/oauth/integrations/callback",
      });
      expect(action).toMatchObject({ type: "oauth_client", integrationId: "integration:1" });
      expect(steps(action).map((step) => step.copy?.value)).toContain(
        "https://cogenly.example.com/oauth/integrations/callback",
      );
      expect(action).not.toHaveProperty("catalogId");
    }
  });
});

describe("setupActionFor, from errors", () => {
  it("maps every failure to the control that fixes it", () => {
    const slack = { entry: entry("slack"), integration: account() };
    expect(setupActionFor({ ...slack, reason: "client_id_required" })?.type).toBe("oauth_client");
    expect(setupActionFor({ ...slack, status: "error", reason: "upstream_timeout" })).toMatchObject(
      { type: "retry", button: "test" },
    );
    expect(
      setupActionFor({ ...slack, status: "needs_sign_in", reason: "upstream_unreachable" }),
    ).toMatchObject({ type: "retry", button: "sign_in" });
    expect(
      setupActionFor({
        ...slack,
        status: "error",
        reason: "upstream_error",
        message: "The server answered with an error. missing_scope",
      }),
    ).toMatchObject({ type: "retry", message: "The server answered with an error. missing_scope" });
    expect(setupActionFor({ ...slack, reason: "disabled" })).toMatchObject({
      type: "fix",
      button: "enable",
    });
    expect(setupActionFor({ ...slack, reason: "approval_required" })?.type).toBe("fix");
    expect(
      setupActionFor({
        entry: entry("google-workspace"),
        reason: "local_runtime_missing",
        runtime: { canInstall: true, command: "brew install uv" },
      }),
    ).toMatchObject({ type: "install_runtime", runtime: "uv", canInstall: true });
    // Connected and unchecked accounts need nothing.
    expect(setupActionFor({ ...slack, status: "connected" })).toBeUndefined();
    expect(setupActionFor({ ...slack, status: "unknown" })).toBeUndefined();
  });

  it("asks again for the secret a missing or refused vault item held", () => {
    const withApp = account({ clientId: "1.2", clientSecret: "{{credential:slack-acme.value}}" });
    expect(
      setupActionFor({
        entry: entry("slack"),
        integration: withApp,
        reason: "credential_unresolved",
      }),
    ).toMatchObject({ type: "oauth_client", message: expect.stringContaining("missing") });
    const withKey = {
      ...account(),
      displayName: "Linear",
      headers: { Authorization: "Bearer {{credential:linear-api-key.value}}" },
    };
    expect(
      setupActionFor({
        entry: entry("linear"),
        integration: withKey,
        reason: "credential_not_allowed",
      }),
    ).toMatchObject({ type: "api_key", message: expect.stringContaining("isn't allowed") });
    expect(
      setupActionFor({ entry: undefined, integration: withKey, reason: "credential_unresolved" }),
    ).toMatchObject({ type: "fix", button: "edit" });
  });

  it("words an account signed in on another machine as signing in on this one", () => {
    const syncedFrom = { machineLabel: "Studio Mac" };
    expect(
      setupActionFor({
        entry: entry("notion"),
        integration: { ...account(), displayName: "Notion", accountLabel: "Work" },
        status: "needs_sign_in",
        syncedFrom,
      }),
    ).toMatchObject({
      type: "sign_in",
      title: "Sign in on this machine",
      message:
        "Notion (Work) was connected on Studio Mac. Sign in here too so agents on this machine can use it.",
    });
    // A Slack or GitHub app's secret stays on the machine that saved it.
    expect(
      setupActionFor({
        entry: entry("slack"),
        integration: account({ clientId: "1.2", clientSecret: "{{credential:slack-acme.value}}" }),
        status: "needs_sign_in",
        syncedFrom,
      }),
    ).toMatchObject({
      type: "oauth_client",
      title: "Sign in on this machine",
      message: expect.stringContaining("Studio Mac"),
    });
  });
});

describe("agentNextStep", () => {
  it("gives the agent private setup instructions rather than a Settings wizard", () => {
    const text = agentNextStep(catalogSetupFor({ entry: entry("slack"), mode: "oauth_app" })!, {
      entry: entry("slack"),
      accountLabel: "Acme",
    });
    expect(text).toContain("request_secret");
    expect(text).toContain("clientSecret {{credential:");
    expect(text).toContain("Retry integration_add");
    expect(text).not.toContain("The user can do this in Settings");
  });
  it("has the agent do console work itself, named Cogenly, leaving only consent to the user", () => {
    const google = setupActionFor({
      entry: entry("google-workspace"),
      reason: "google_client_missing",
      redirectUri: "https://cogenly.example.com/oauth/integrations/google/callback",
    })!;
    const cases = [
      [google, entry("google-workspace")],
      [catalogSetupFor({ entry: entry("slack"), mode: "oauth_app" })!, entry("slack")],
      [catalogSetupFor({ entry: entry("github"), mode: "oauth_app" })!, entry("github")],
      [catalogSetupFor({ entry: entry("github"), mode: "api_key" })!, entry("github")],
      [catalogSetupFor({ entry: entry("linear"), mode: "api_key" })!, entry("linear")],
    ] as const;
    for (const [action, service] of cases) {
      const text = agentNextStep(action, {
        entry: service,
      });
      expect(text).toContain("collaborative browser");
      expect(text).toContain("Cogenly");
      expect(text).toContain("setupNotes");
      expect(text).toContain("Do not hand these steps to the user.");
      // The old guides handed the user the console steps.
      expect(text).not.toMatch(/help the user create|paste (it|them) here|may require the user/i);
      expect(text).not.toMatch(/into view|reply "?go/i);
    }
    const googleText = agentNextStep(google, {
      entry: entry("google-workspace"),
    });
    // Reuse before create, and the client goes straight to the vault.
    expect(googleText.indexOf("Reuse it if it exists")).toBeLessThan(
      googleText.indexOf("https://console.cloud.google.com/projectcreate"),
    );
    expect(googleText).toContain('vault_capture {name: "google-oauth-client"');
    expect(googleText).toContain("cogenly-");
  });

  it("keeps precise failures while directing setup to the agent", () => {
    const { message, transient } = agentFailureMessage({
      operation: "create",
      reason: "google_client_missing",
    });
    expect(transient).toBe(false);
    expect(message).toContain("google-oauth-client");
    expect(message).not.toContain("google_client_missing");
    expect(agentFailureMessage({ operation: "test", reason: "upstream_timeout" }).transient).toBe(
      true,
    );
    expect(agentFailureMessage({ operation: "update", reason: "not_found" }).message).toContain(
      "No connected integration",
    );
  });

  it("names the refusing step and the OAuth server's error instead of a generic failure", () => {
    const refused = agentFailureMessage({
      operation: "validate private endpoint",
      reason: "invalid_request",
    }).message;
    expect(refused).toContain('"validate private endpoint"');
    expect(refused).not.toContain("/settings/");
    const oauth = agentFailureMessage({
      operation: "register",
      reason: "upstream_error",
      oauthFailure: {
        stage: "DCR",
        host: "mcp-auth.wisprflow.com",
        status: 400,
        error: "invalid_redirect_uri",
        description: "Redirect not allowed",
      },
    });
    expect(oauth.message).toBe(
      "OAuth DCR failed at mcp-auth.wisprflow.com (HTTP 400): invalid_redirect_uri (Redirect not allowed).",
    );
    expect(oauth.transient).toBe(true);
  });
});

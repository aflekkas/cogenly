import { describe, expect, it } from "vite-plus/test";
import { integrationSetupGuide } from "./IntegrationSetupGuides.ts";

describe("agent setup knowledge", () => {
  it("walks Gmail through a private client request and account consent", () => {
    const guide = integrationSetupGuide("Gmail");
    expect(guide.service).toBe("google-workspace");
    expect(guide.instructions).toContain("google-oauth-client");
    expect(guide.instructions).toContain("request_secret");
    expect(guide.instructions).toContain("/oauth/integrations/google/callback");
    expect(guide.instructions).toContain("integration_test");
  });
  it("connects Wispr through OAuth and explains its account prerequisites", () => {
    const guide = integrationSetupGuide("Wispr Flow");
    expect(guide.service).toBe("wispr-flow");
    expect(guide.instructions).toContain("https://api.wisprflow.ai/connect/mcp");
    expect(guide.instructions).toContain("Cloud Sync");
    expect(guide.instructions).toContain("HIPAA");
  });
  it("covers every supported service and falls back to a URL or command", () => {
    for (const service of ["slack", "github", "linear", "notion", "fathom"]) {
      expect(integrationSetupGuide(service).service).toBe(service);
      expect(integrationSetupGuide(service).instructions).toContain("https://");
    }
    expect(integrationSetupGuide("unknown").instructions).toContain("transport stdio");
    expect(integrationSetupGuide("unknown").instructions).toContain("never argv");
  });
});

it("Google setup preserves once-only credentials and handles Testing/publication blockers", () => {
  const guide = integrationSetupGuide("google-workspace");
  expect(guide.instructions).toContain("vault_capture");
  expect(guide.instructions).toContain("test user");
  expect(guide.instructions).toContain("seven days");
  expect(guide.instructions).toContain("Branding incomplete");
  expect(guide.instructions).toContain("Publish does nothing");
  expect(guide.instructions).toContain("Search Console");
});

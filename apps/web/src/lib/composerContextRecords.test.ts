import { IntegrationContextRecord, type IntegrationSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { integrationContextRecord } from "./composerContextRecords";

const gmail = {
  id: "int_gmail_work",
  name: "gmail-work",
  displayName: "Google Workspace (work)",
  icon: "google-workspace",
  serviceName: "Google Workspace",
  accountLabel: "work",
  status: "connected",
  scope: { type: "all" },
} as unknown as IntegrationSource;

const isIntegrationRecord = Schema.is(IntegrationContextRecord);

describe("integrationContextRecord", () => {
  it("names the account the agent calls and reads as service and account", () => {
    const record = integrationContextRecord(gmail);
    expect(isIntegrationRecord(record)).toBe(true);
    expect(record).toMatchObject({
      kind: "integration",
      label: "Google Workspace · work",
      integrationId: "int_gmail_work",
      name: "gmail-work",
      icon: "google-workspace",
    });
  });

  it("keeps one record per integration, so picking it again reuses the chip's record", () => {
    expect(integrationContextRecord(gmail).contextId).toBe(
      integrationContextRecord({ ...gmail, accountLabel: "renamed" }).contextId,
    );
  });

  it("still sends when the account's display strings outgrow the record's bound", () => {
    const record = integrationContextRecord({ ...gmail, accountLabel: "a".repeat(500) });
    expect(isIntegrationRecord(record)).toBe(true);
  });
});

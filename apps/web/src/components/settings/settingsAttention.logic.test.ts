import { EnvironmentId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  integrationAttentionTone,
  machineCheckAttention,
  scheduledTaskAttentionTone,
  settingsAttentionByPage,
  settingsPagesForAlert,
  worstAttentionTone,
  type SettingsAttentionAlert,
} from "./settingsAttention.logic";

const mac = EnvironmentId.make("env-mac");
const vps = EnvironmentId.make("env-vps");

const alert = (overrides: Partial<SettingsAttentionAlert> = {}): SettingsAttentionAlert => ({
  originEnvironmentId: mac,
  checkId: "server",
  status: "fail",
  target: null,
  ...overrides,
});

describe("settingsPagesForAlert", () => {
  it("puts every alert on Machines, and on the page that fixes it", () => {
    const pages = (overrides: Partial<SettingsAttentionAlert>) =>
      settingsPagesForAlert(alert(overrides));
    expect(pages({ checkId: "providers" })).toEqual(["/settings/machines", "/settings/providers"]);
    expect(
      pages({
        checkId: "providers",
        target: { _tag: "provider", instanceId: ProviderInstanceId.make("claude") },
      }),
    ).toEqual(["/settings/machines", "/settings/providers"]);
    expect(
      pages({ checkId: "integrations", target: { _tag: "integration", name: "linear" } }),
    ).toEqual(["/settings/machines", "/settings/integrations"]);
    expect(pages({ checkId: "computer-use" })).toEqual([
      "/settings/machines",
      "/settings/integrations",
    ]);
    expect(pages({ checkId: "scheduled-tasks" })).toEqual([
      "/settings/machines",
      "/settings/scheduled-tasks",
    ]);
    expect(pages({ checkId: "disk" })).toEqual(["/settings/machines", "/settings/storage"]);
    expect(pages({ checkId: "database" })).toEqual(["/settings/machines", "/settings/storage"]);
  });

  it("keeps machine-wide checks on Machines alone", () => {
    for (const checkId of [
      "server",
      "machine-links",
      "sync",
      "stuck-runs",
      "boot-service",
      "tailscale-serve",
      "canary",
      "chat-terminal-sandbox",
      "agent-processes",
    ] as const) {
      expect(settingsPagesForAlert(alert({ checkId }))).toEqual(["/settings/machines"]);
    }
    // Version skew and sync quarantine name the machine to update or retry.
    for (const checkId of ["machine-links", "sync"] as const) {
      expect(
        settingsPagesForAlert(alert({ checkId, target: { _tag: "machine", environmentId: vps } })),
      ).toEqual(["/settings/machines"]);
    }
  });
});

describe("settingsAttentionByPage", () => {
  it("gives each page its own dot, the worst alert on it", () => {
    const byPage = settingsAttentionByPage([
      alert({ checkId: "providers", status: "warn" }),
      alert({ checkId: "disk", status: "fail" }),
    ]);
    expect(Object.fromEntries(byPage)).toEqual({
      "/settings/machines": "destructive",
      "/settings/providers": "warning",
      "/settings/storage": "destructive",
    });
  });

  it("shows nothing once the alerts clear", () => {
    expect(settingsAttentionByPage([]).size).toBe(0);
    expect(settingsAttentionByPage([alert({ status: "ok" })]).size).toBe(0);
  });

  it("shows a silent turn as an amber Machines dot, and an over-age run as red", () => {
    const thread = { _tag: "thread" as const, threadId: ThreadId.make("thread-1") };
    const silent = alert({ checkId: "stuck-runs", status: "warn", target: thread });
    expect(Object.fromEntries(settingsAttentionByPage([silent]))).toEqual({
      "/settings/machines": "warning",
    });
    expect(
      settingsAttentionByPage([silent, { ...silent, status: "fail" }]).get("/settings/machines"),
    ).toBe("destructive");
  });

  it("agrees with the rail's dot", () => {
    const alerts = [alert({ checkId: "sync", status: "unknown" })];
    expect(worstAttentionTone(alerts)).toBe("warning");
    expect(settingsAttentionByPage(alerts).get("/settings/machines")).toBe("warning");
  });
});

describe("row dots", () => {
  it("marks a machine's checks only on the machine the alert is from", () => {
    const alerts = [alert({ checkId: "sync", status: "warn", originEnvironmentId: vps })];
    expect(machineCheckAttention(alerts, vps).get("sync")).toBe("warning");
    expect(machineCheckAttention(alerts, mac).size).toBe(0);
  });

  it("marks the integration and scheduled task the alert names, on its machine", () => {
    const taskId = ScheduledTaskId.make("task-1");
    const alerts = [
      alert({ checkId: "integrations", target: { _tag: "integration", name: "linear" } }),
      alert({
        checkId: "scheduled-tasks",
        status: "warn",
        target: { _tag: "scheduledTask", taskId },
      }),
    ];
    expect(integrationAttentionTone(alerts, mac, "linear")).toBe("destructive");
    expect(integrationAttentionTone(alerts, mac, "slack")).toBeNull();
    expect(integrationAttentionTone(alerts, vps, "linear")).toBeNull();
    expect(scheduledTaskAttentionTone(alerts, mac, taskId)).toBe("warning");
    expect(scheduledTaskAttentionTone(alerts, mac, "task-2")).toBeNull();
  });
});

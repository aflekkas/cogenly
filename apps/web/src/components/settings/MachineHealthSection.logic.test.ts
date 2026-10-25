import type {
  EnvironmentId,
  IntegrationSummary,
  MachineHealthCheck,
  MachineHealthReport,
  MachineInfo,
  MachineListResult,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  alertChannelIntegrations,
  canaryIntervalOptions,
  canaryMachineId,
  channelTestLines,
  healthHeadline,
  machineHealthView,
  MACHINE_CONNECT_GRACE_MS,
  unreachableHeadline,
} from "./MachineHealthSection.logic";

const env = (id: string) => id as EnvironmentId;

function machine(id: string, relation: MachineInfo["relation"]): MachineInfo {
  return {
    environmentId: env(id),
    name: id,
    kind: "other-computer",
    hardware: "laptop",
    platform: "darwin",
    relation,
    online: true,
    lastSeenAt: null,
    pairedAt: null,
    pairing: relation === "this" ? "self" : "paired",
    providers: [],
  };
}

describe("canaryMachineId", () => {
  it("puts the canary on the hub, seen from the hub or from a spoke", () => {
    const fromHub: MachineListResult = {
      machines: [machine("hub", "this"), machine("laptop", "spoke")],
      link: { _tag: "hub", spokes: 1 },
    };
    const fromSpoke: MachineListResult = {
      machines: [machine("laptop", "this"), machine("hub", "hub")],
      link: {
        _tag: "spoke",
        hubEnvironmentId: env("hub"),
        status: "online",
        route: null,
        lastError: null,
      },
    };
    expect(canaryMachineId(fromHub)).toBe("hub");
    expect(canaryMachineId(fromSpoke)).toBe("hub");
  });

  it("offers it on this machine when it is not paired", () => {
    expect(
      canaryMachineId({ machines: [machine("solo", "this")], link: { _tag: "standalone" } }),
    ).toBe("solo");
  });
});

describe("unreachableHeadline", () => {
  const now = 10 * 60 * 60_000;
  it("says how long the machine has been out of reach", () => {
    expect(unreachableHeadline("Contabo VPS", now - 10 * 60_000, now)).toBe(
      "Contabo VPS hasn't been reachable for 10 minutes",
    );
    expect(unreachableHeadline("Contabo VPS", now - 3 * 60 * 60_000, now)).toBe(
      "Contabo VPS hasn't been reachable for 3 hours",
    );
  });

  it("does not invent a duration it does not know", () => {
    expect(unreachableHeadline("Contabo VPS", null, now)).toBe(
      "Contabo VPS can't be reached right now",
    );
  });
});

describe("healthHeadline", () => {
  const check = (status: MachineHealthCheck["status"]): MachineHealthCheck => ({
    id: "disk",
    status,
    summary: "",
    items: [],
  });
  const report = (checks: MachineHealthCheck[]): MachineHealthReport => ({
    environmentId: env("hub"),
    machineName: "hub",
    status: "ok",
    observedAt: DateTime.makeUnsafe(0),
    serverVersion: "0.3.0",
    uptimeSeconds: 0,
    reachable: true,
    checks,
  });

  it("leads with failures, then warnings", () => {
    expect(healthHeadline(report([check("warn"), check("fail"), check("fail")]))).toBe(
      "2 checks are failing",
    );
    expect(healthHeadline(report([check("ok"), check("warn")]))).toBe("1 check needs attention");
    expect(healthHeadline(report([check("ok"), check("unknown")]))).toBe("Everything is working");
  });
});

describe("canaryIntervalOptions", () => {
  it("keeps a saved interval that is not a preset selectable", () => {
    const minutes = canaryIntervalOptions(45).map((option) => option.minutes);
    expect(minutes).toEqual([15, 30, 45, 60, 180, 360, 1440]);
    expect(canaryIntervalOptions(60).map((option) => option.minutes)).not.toContain(45);
  });
});

describe("alertChannelIntegrations", () => {
  function summary(
    name: string,
    url: string,
    overrides: Partial<IntegrationSummary["integration"]> = {},
  ): IntegrationSummary {
    return {
      integration: {
        id: name as IntegrationSummary["integration"]["id"],
        name: name as IntegrationSummary["integration"]["name"],
        displayName: name,
        transport: "http",
        url,
        headers: {},
        enabled: true,
        scope: { type: "all" },
        hint: "",
        createdAt: "2026-01-01T00:00:00.000Z" as IntegrationSummary["integration"]["createdAt"],
        updatedAt: "2026-01-01T00:00:00.000Z" as IntegrationSummary["integration"]["updatedAt"],
        deletedAt: null,
        ...overrides,
      },
      status: "connected",
      toolCount: null,
    };
  }

  it("lists only live integrations connected from that service", () => {
    const integrations = [
      summary("slack", "https://mcp.slack.com/mcp"),
      summary("old-slack", "https://mcp.slack.com/mcp", {
        deletedAt: "2026-02-01T00:00:00.000Z" as IntegrationSummary["integration"]["createdAt"],
      }),
      summary("linear", "https://mcp.linear.app/mcp"),
    ];
    expect(alertChannelIntegrations(integrations, "slack", null).map((o) => o.name)).toEqual([
      "slack",
    ]);
  });

  it("keeps a saved integration that has since been removed", () => {
    expect(alertChannelIntegrations([], "slack", "gone")).toEqual([
      { name: "gone", label: "gone (removed)", connected: false },
    ]);
  });
});

describe("channelTestLines", () => {
  it("tells sent, failed and skipped channels apart", () => {
    expect(
      channelTestLines({
        slack: { attempted: true, ok: false, error: "not_in_channel" },
        email: { attempted: false, ok: false, error: null },
      }),
    ).toEqual([
      { channel: "Slack", state: "failed", text: "not_in_channel" },
      { channel: "Email", state: "skipped", text: "Off or not set up, so nothing was sent." },
    ]);
  });
});

describe("machineHealthView", () => {
  const nowMs = 1_000_000;
  const peer = {
    relation: "spoke" as const,
    online: true,
    pairedAtMs: nowMs - 10_000,
    lastSeenAtMs: null,
  };
  const report: MachineHealthReport = {
    environmentId: env("peer"),
    machineName: "MacBook",
    status: "fail",
    observedAt: DateTime.makeUnsafe(nowMs),
    serverVersion: "0.3.0",
    uptimeSeconds: 0,
    reachable: false,
    checks: [],
  };

  it.each([true, false])(
    "shows Connecting for an unreachable peer during grace (online=%s)",
    (online) => {
      expect(
        machineHealthView({ report, failed: false, machine: { ...peer, online }, nowMs }),
      ).toEqual({ _tag: "connecting" });
    },
  );

  it.each([true, false])("shows Connecting with no report during grace (failed=%s)", (failed) => {
    expect(machineHealthView({ report: null, failed, machine: peer, nowMs })).toEqual({
      _tag: "connecting",
    });
  });

  it("never describes an online peer as unreachable after grace", () => {
    expect(
      machineHealthView({
        report,
        failed: false,
        machine: peer,
        nowMs: nowMs + MACHINE_CONNECT_GRACE_MS,
      }),
    ).toEqual({ _tag: "report", overall: "unknown", unreachable: "unanswered" });
  });

  it("shows failure for an offline peer after grace", () => {
    expect(
      machineHealthView({
        report,
        failed: false,
        machine: { ...peer, online: false },
        nowMs: nowMs + MACHINE_CONNECT_GRACE_MS,
      }),
    ).toEqual({ _tag: "report", overall: "fail", unreachable: "offline" });
  });

  it("preserves a received report's actual health during grace", () => {
    expect(
      machineHealthView({
        report: { ...report, reachable: true },
        failed: false,
        machine: peer,
        nowMs,
      }),
    ).toEqual({ _tag: "report", overall: "fail", unreachable: null });
  });
});

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type MachineHealthReport } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { describeHealthReport, healthExitCode } from "./health.ts";

const report: MachineHealthReport = {
  environmentId: EnvironmentId.make("environment-vps"),
  machineName: "Contabo VPS",
  status: "warn",
  observedAt: DateTime.makeUnsafe("2026-10-24T09:00:00.000Z"),
  serverVersion: "0.3.0",
  uptimeSeconds: 3600,
  reachable: false,
  checks: [
    { id: "server", status: "ok", summary: "Up 1 hour", items: [] },
    {
      id: "stuck-runs",
      status: "warn",
      summary: "1 run is stuck",
      items: [
        {
          key: "stuck-runs:thread-1",
          status: "warn",
          title: "Nightly report",
          detail: "No progress for 40 minutes.",
          since: null,
          target: { _tag: "thread", threadId: ThreadId.make("thread-1") },
          fix: "resume",
        },
        {
          key: "stuck-runs:thread-2",
          status: "warn",
          title: "Inbox sweep",
          detail: "",
          since: null,
          target: null,
          fix: null,
        },
        {
          key: "stuck-runs:ok",
          status: "ok",
          title: "Other runs are moving",
          detail: "",
          since: null,
          target: null,
          fix: null,
        },
      ],
    },
  ],
};

describe("cogenly health", () => {
  it("prints each check and only the problems under it", () => {
    expect(describeHealthReport(report)).toBe(
      [
        "Contabo VPS: warn (observed 2026-10-24T09:00:00.000Z)",
        "Not reachable: this report is built from what this machine last saw of it.",
        "ok       server      Up 1 hour",
        "warn     stuck-runs  1 run is stuck",
        "  - Nightly report",
        "      No progress for 40 minutes.",
        "  - Inbox sweep",
      ].join("\n"),
    );
  });

  it("fails the process only when the report fails", () => {
    expect(healthExitCode(report)).toBe(0);
    expect(healthExitCode({ ...report, status: "unknown" })).toBe(0);
    expect(healthExitCode({ ...report, status: "fail" })).toBe(1);
  });
});

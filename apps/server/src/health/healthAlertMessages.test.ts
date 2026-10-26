import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineHealthAlert } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import {
  alertGroupMessage,
  alertMessage,
  emailSendCall,
  groupAlertsByCheck,
  sanitizeAlertText,
  slackSendCall,
} from "./healthAlertMessages.ts";

describe("sanitizeAlertText", () => {
  it.each([
    ["Bearer abcdefghijklmnop1234", "Bearer [redacted]"],
    ["token=abc123 failed", "token=[redacted] failed"],
    ['password: "hunter2 hunter2"', "password: [redacted]"],
    ["Authorization: Bearer abc.def.ghi-123", "Authorization: [redacted] [redacted]"],
    ["key sk-ant-api03-abcdefghijklmnop", "key [redacted]"],
    ["slack xoxb-1234-5678-abcdefgh", "slack [redacted]"],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz0123", "gh [redacted]"],
    ["aws AKIAABCDEFGHIJKLMNOP", "aws [redacted]"],
    ["google ya29.a0AfH6SMBabcdefgh", "google [redacted]"],
    ["jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4", "jwt [redacted]"],
    ["blob 3f9a8c7d6e5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f", "blob [redacted]"],
    [
      "see https://user:pw@hooks.example.com/services/T0/B0/secret?token=x for more",
      "see https://hooks.example.com for more",
    ],
  ])("strips %s", (input, expected) => {
    expect(sanitizeAlertText(input)).toBe(expected);
  });

  it("keeps ordinary health text, on one bounded line", () => {
    expect(sanitizeAlertText("Contabo VPS hasn't been reachable for 10 minutes")).toBe(
      "Contabo VPS hasn't been reachable for 10 minutes",
    );
    expect(sanitizeAlertText("Last seen 2026-10-24T10:00:00.000Z.\n\nRetry")).toBe(
      "Last seen 2026-10-24T10:00:00.000Z. Retry",
    );
    expect(sanitizeAlertText("x".repeat(400), 20)).toHaveLength(20);
  });
});

const alert: MachineHealthAlert = {
  id: "hub:providers:claude:0",
  originEnvironmentId: EnvironmentId.make("hub"),
  originMachineName: "Contabo VPS",
  itemKey: "providers:claude",
  checkId: "providers",
  state: "open",
  status: "fail",
  title: "Claude needs sign-in",
  detail: "Refresh failed with access_token=abc123secret",
  openedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 24, 10)),
  resolvedAt: null,
  target: null,
  fix: "sign-in",
};

describe("alertMessage", () => {
  it("names the machine, title, status, detail and time, with nothing secret", () => {
    const message = alertMessage(alert, "opened");
    expect(message.subject).toBe("Cogenly health alert on Contabo VPS: Claude needs sign-in");
    expect(message.text).toBe(
      [
        "Cogenly health alert on Contabo VPS: Claude needs sign-in",
        "Status: fail",
        "Detail: Refresh failed with access_token=[redacted]",
        "Since: 2026-10-24T10:00:00.000Z",
        "Open Cogenly → Settings → Machines for details.",
      ].join("\n"),
    );
    expect(message.text).not.toContain("abc123secret");
  });
});

describe("grouped alert messages", () => {
  const stuck = (thread: string): MachineHealthAlert => ({
    ...alert,
    id: `hub:stuck-runs:thread:${thread}:0`,
    itemKey: `stuck-runs:thread:${thread}`,
    checkId: "stuck-runs",
    title: `"${thread}" has been running for 2 days`,
  });

  it("sends one message per machine and check for a burst of alerts", () => {
    const burst = [...Array.from({ length: 10 }, (_, index) => stuck(`Thread ${index}`)), alert];
    const groups = groupAlertsByCheck(burst);
    expect(groups.map((group) => group.length)).toEqual([10, 1]);
    const message = alertGroupMessage(groups[0]!, "opened")!;
    expect(message.subject).toBe("Cogenly health alert on Contabo VPS: 10 problems");
    expect(message.text.split("\n")).toEqual([
      "Cogenly health alert on Contabo VPS: 10 problems",
      ...Array.from({ length: 8 }, (_, index) => `- "Thread ${index}" has been running for 2 days`),
      "…and 2 more.",
      "Open Cogenly → Settings → Machines for details.",
    ]);
    // A group of one reads like a single alert.
    expect(alertGroupMessage(groups[1]!, "opened")).toEqual(alertMessage(alert, "opened"));
  });
});

describe("send tool discovery", () => {
  const tool = (name: string, properties: Record<string, unknown>) => ({
    name,
    description: "",
    inputSchema: { type: "object", properties },
  });

  it("DMs a Slack member through the send-message tool", () => {
    const tools = [
      tool("slack_send_message_draft", { channel_id: {}, message: {} }),
      tool("slack_send_message", { channel_id: {}, message: {} }),
    ];
    expect(slackSendCall(tools, "U012ABCDEF", "hi")).toEqual({
      tool: "slack_send_message",
      args: { channel_id: "U012ABCDEF", message: "hi" },
    });
    expect(
      slackSendCall([tool("chat_postMessage", { channel: {}, text: {} })], "U1", "hi"),
    ).toEqual({ tool: "chat_postMessage", args: { channel: "U1", text: "hi" } });
    expect(slackSendCall([tool("slack_read_channel", {})], "U1", "hi")).toBeNull();
  });

  it("sends Gmail through workspace-mcp's tool, shaping recipients by schema", () => {
    const message = { subject: "Subject", text: "Body" };
    expect(
      emailSendCall(
        [
          tool("draft_gmail_message", {}),
          tool("send_gmail_message", { user_google_email: {}, to: {}, subject: {}, body: {} }),
        ],
        "me@example.com",
        message,
      ),
    ).toEqual({
      tool: "send_gmail_message",
      args: {
        user_google_email: "default",
        to: "me@example.com",
        subject: "Subject",
        body: "Body",
      },
    });
    expect(
      emailSendCall(
        [tool("send_message", { to: { type: "array" }, body: {} })],
        "me@x.com",
        message,
      ),
    ).toEqual({
      tool: "send_message",
      args: { to: ["me@x.com"], subject: "Subject", body: "Body" },
    });
  });
});

import {
  ThreadId,
  TurnItemId,
  type ComputerUseStatus,
  type OrchestrationV2TurnItem,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  computerUseGrantMissing,
  computerUseHostAppNote,
  computerUsePermissionPrompt,
  computerUseUnsupportedLine,
  refusedComputerUsePermission,
} from "./computerUse.logic";

const at = DateTime.makeUnsafe("2026-10-25T12:00:00.000Z");
const permissionText = (title: string) =>
  `macOS has not granted Cogenly ${title} yet. The user has to turn it on once in System Settings → Privacy & Security → ${title}; this thread now shows them a button that opens that pane.`;

let ordinal = 0;
function call(
  toolName: string,
  status: OrchestrationV2TurnItem["status"],
  output?: unknown,
): OrchestrationV2TurnItem {
  ordinal += 1;
  return {
    id: TurnItemId.make(`call-${ordinal}`),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input: {},
    ...(output === undefined ? {} : { output }),
  };
}

describe("computerUsePermissionPrompt", () => {
  it("asks for the grant a failed call needs, in Claude's and Codex's spellings", () => {
    // The timeline keeps only `{ isError: true }` of a failed call's output.
    const claude = call("mcp__cogenly__computer_click", "failed", { isError: true });
    expect(computerUsePermissionPrompt([claude])).toEqual({
      itemId: claude.id,
      permission: "accessibility",
    });
    const codex = call("cogenly.computer_screenshot", "failed");
    expect(computerUsePermissionPrompt([codex])).toEqual({
      itemId: codex.id,
      permission: "screen-recording",
    });
  });

  it("shows one prompt, after the latest failure", () => {
    const first = call("mcp__cogenly__computer_click", "failed");
    const second = call("mcp__cogenly__computer_type", "failed");
    expect(computerUsePermissionPrompt([first, second])?.itemId).toBe(second.id);
  });

  it("drops a grant once a later call that needs it succeeds", () => {
    const failed = call("mcp__cogenly__computer_click", "failed");
    const shot = call("mcp__cogenly__computer_screenshot", "failed");
    const clicked = call("mcp__cogenly__computer_key", "completed", { frontmostApp: "Dia" });
    expect(computerUsePermissionPrompt([failed, shot, clicked])).toEqual({
      itemId: shot.id,
      permission: "screen-recording",
    });
    expect(computerUsePermissionPrompt([failed, clicked])).toBeNull();
  });

  it("reads the refused grant from the error text when the client has it", () => {
    const text = call("cogenly.computer_click", "failed", [
      { type: "text", text: permissionText("Screen Recording") },
    ]);
    expect(computerUsePermissionPrompt([text])?.permission).toBe("screen-recording");
    const other = call("cogenly.computer_key", "failed", 'Unknown key "hyper".');
    expect(computerUsePermissionPrompt([other])).toBeNull();
  });

  it("ignores tools that need no grant, running calls and other servers", () => {
    expect(
      computerUsePermissionPrompt([
        call("cogenly.computer_open_app", "failed"),
        call("cogenly.computer_status", "failed"),
        call("mcp__cogenly__computer_click", "running"),
        call("mcp__other__computer_click", "failed"),
      ]),
    ).toBeNull();
  });
});

describe("refusedComputerUsePermission", () => {
  it("reads the encoded error and the agent-facing message", () => {
    expect(
      refusedComputerUsePermission(
        JSON.stringify({
          _tag: "ComputerUseUnavailableError",
          code: "permission-missing",
          missing: ["screen-recording"],
          reason: "…",
        }),
      ),
    ).toBe("screen-recording");
    expect(
      refusedComputerUsePermission(
        JSON.stringify({ _tag: "ComputerUseUnavailableError", code: "disabled", reason: "off" }),
      ),
    ).toBe("other");
    expect(refusedComputerUsePermission(permissionText("Accessibility"))).toBe("accessibility");
    expect(refusedComputerUsePermission("The owner turned computer use off.")).toBe("other");
  });
});

const status = (overrides: Partial<ComputerUseStatus>): ComputerUseStatus => ({
  state: "needs-permission",
  enabled: true,
  supported: true,
  platform: "darwin",
  hostApp: "Cogenly",
  permissions: [
    {
      permission: "accessibility",
      grant: "missing",
      title: "Accessibility",
      neededFor: "clicking, typing and reading other apps' controls",
      settingsUrl: "x-apple.systempreferences:",
    },
    {
      permission: "screen-recording",
      grant: "granted",
      title: "Screen Recording",
      neededFor: "taking screenshots of the screen",
      settingsUrl: "x-apple.systempreferences:",
    },
  ],
  nextSteps: [],
  ...overrides,
});

describe("computer use status", () => {
  it("counts only an available machine's ungranted permissions as missing", () => {
    expect(computerUseGrantMissing(status({}))).toBe(true);
    expect(computerUseGrantMissing(status({}), "accessibility")).toBe(true);
    expect(computerUseGrantMissing(status({}), "screen-recording")).toBe(false);
    expect(computerUseGrantMissing(status({ state: "disabled" }))).toBe(false);
  });

  it("names the app to switch on when it is not Cogenly", () => {
    expect(computerUseHostAppNote(status({}))).toBeNull();
    expect(computerUseHostAppNote(status({ hostApp: "Ghostty" }))).toContain("Ghostty");
    expect(computerUseHostAppNote(status({ hostApp: null }))).toContain("another app");
  });

  it("says plainly why an unsupported machine cannot", () => {
    expect(
      computerUseUnsupportedLine(
        status({ state: "unsupported", platform: "linux", hostApp: null }),
      ),
    ).toBe("Not available on Linux servers. Computer use controls a Mac's apps.");
    expect(computerUseUnsupportedLine(status({}))).toBeNull();
  });
});

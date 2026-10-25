import {
  type ComputerUsePermission,
  ComputerUseUnavailableError,
  ServerSettings,
} from "@cogenly/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ComputerHost } from "./ComputerHost.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

/** A fake macOS whose privacy grants the test flips, recording what the service asked it to do. */
const fakeMac = (initial: { accessibility: boolean; screenRecording: boolean }) => {
  const grants = { ...initial };
  const calls: Array<string> = [];
  const opened: Array<ReadonlyArray<string>> = [];
  const host = ComputerHost.of({
    platform: "darwin",
    hostApp: "Cogenly",
    script: (input) =>
      Effect.sync(() => {
        calls.push(input.op);
        const granted = (permission: ComputerUsePermission) =>
          permission === "accessibility" ? grants.accessibility : grants.screenRecording;
        if (input.needs !== undefined && !granted(input.needs)) {
          return { _tag: "missing" as const, permission: input.needs };
        }
        switch (input.op) {
          case "probe":
          case "request":
            return { _tag: "ok" as const, value: { ...grants, displays: 1 } };
          case "displays":
            return {
              _tag: "ok" as const,
              value: {
                displays: [{ display: 1, x: 0, y: 0, width: 1440, height: 900 }],
                frontmostApp: "Dia",
              },
            };
          default:
            return { _tag: "ok" as const, value: { frontmostApp: "Dia" } };
        }
      }),
    capture: () => Effect.succeed(new Uint8Array()),
    open: (args) => Effect.sync(() => void opened.push(args)),
  });
  return {
    grants,
    calls,
    opened,
    layer: ComputerUseService.layer.pipe(Layer.provide(Layer.succeed(ComputerHost, host))),
  };
};

const missingOf = (error: ComputerUseUnavailableError) => ({
  code: error.code,
  missing: error.missing,
});

describe("ComputerUse", () => {
  it("is on by default for every agent", () => {
    expect(decodeSettings({}).enableAgentComputerUse).toBe(true);
  });

  it.effect("sees a permission the user grants on the very next call, with no restart", () => {
    const mac = fakeMac({ accessibility: false, screenRecording: false });
    return Effect.gen(function* () {
      const computer = yield* ComputerUseService.ComputerUse;
      const refused = yield* computer.click({ x: 10, y: 10 }).pipe(Effect.flip);
      expect(missingOf(refused)).toEqual({
        code: "permission-missing",
        missing: ["accessibility"],
      });
      expect(refused.message).toContain("System Settings → Privacy & Security → Accessibility");
      expect((yield* computer.status()).state).toBe("needs-permission");

      mac.grants.accessibility = true;
      expect(yield* computer.click({ x: 10, y: 10 })).toEqual({ frontmostApp: "Dia" });
      // Clicking only needs Accessibility; screenshots still wait on Screen Recording.
      expect((yield* computer.status({ tool: "computer_click" })).state).toBe("ready");
      const screenshot = yield* computer.screenshot({}).pipe(Effect.flip);
      expect(missingOf(screenshot)).toEqual({
        code: "permission-missing",
        missing: ["screen-recording"],
      });

      mac.grants.screenRecording = true;
      expect((yield* computer.status()).state).toBe("ready");
    }).pipe(Effect.provide(mac.layer));
  });

  it.effect("asks macOS to list Cogenly, then opens that exact pane", () => {
    const mac = fakeMac({ accessibility: false, screenRecording: true });
    return Effect.gen(function* () {
      const computer = yield* ComputerUseService.ComputerUse;
      yield* computer.requestPermission("accessibility");
      expect(mac.calls).toContain("request");
      expect(mac.opened).toEqual([
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
      ]);
    }).pipe(Effect.provide(mac.layer));
  });

  it.effect("refuses on Linux without touching the OS", () => {
    const calls: Array<string> = [];
    const linux = ComputerHost.of({
      platform: "linux",
      hostApp: null,
      script: (input) =>
        Effect.sync(() => (calls.push(input.op), { _tag: "ok" as const, value: {} })),
      capture: () => Effect.die("unreachable"),
      open: () => Effect.die("unreachable"),
    });
    return Effect.gen(function* () {
      const computer = yield* ComputerUseService.ComputerUse;
      const error = yield* computer.type({ text: "hi" }).pipe(Effect.flip);
      assert.strictEqual(error.code, "unsupported");
      expect((yield* computer.status()).state).toBe("unsupported");
      expect(calls).toEqual([]);
    }).pipe(
      Effect.provide(
        ComputerUseService.layer.pipe(Layer.provide(Layer.succeed(ComputerHost, linux))),
      ),
    );
  });

  it.effect("rejects an unknown key before sending anything", () => {
    const mac = fakeMac({ accessibility: true, screenRecording: true });
    return Effect.gen(function* () {
      const computer = yield* ComputerUseService.ComputerUse;
      const error = yield* computer.key({ key: "cmd+banana" }).pipe(Effect.flip);
      assert.strictEqual(error.code, "failed");
      expect(mac.calls).not.toContain("key");
    }).pipe(Effect.provide(mac.layer));
  });
});

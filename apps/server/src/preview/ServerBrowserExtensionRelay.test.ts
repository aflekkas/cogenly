// @effect-diagnostics nodeBuiltinImport:off - Drives CDP detach events without Chrome.
import * as NodeEvents from "node:events";
import type { CDPSession } from "playwright-core";
import { expect, it, vi } from "@effect/vitest";
import { ExtensionPipe } from "./ServerBrowserExtensionRelay.ts";

it("rejects pending calls on root and nested target detach without disturbing other sessions", async () => {
  const cdp = Object.assign(new NodeEvents.EventEmitter(), {
    send: vi.fn(async () => ({})),
    detach: vi.fn(async () => {}),
  });
  const pipe = new ExtensionPipe(cdp as unknown as CDPSession);
  cdp.emit("Target.receivedMessageFromTarget", {
    sessionId: "root",
    message: JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "child" } }),
  });
  const root = expect(pipe.send("Runtime.evaluate", {}, "root")).rejects.toThrow("detached");
  const child = expect(pipe.send("Runtime.evaluate", {}, "child")).rejects.toThrow("detached");
  const other = pipe.send("Runtime.evaluate", {}, "other");
  cdp.emit("Target.detachedFromTarget", { sessionId: "root" });
  await Promise.all([root, child]);
  cdp.emit("Target.receivedMessageFromTarget", {
    sessionId: "other",
    message: JSON.stringify({ id: 3, result: { ok: true } }),
  });
  await expect(other).resolves.toEqual({ ok: true });
  const nested = expect(pipe.send("Runtime.evaluate", {}, "nested")).rejects.toThrow("detached");
  cdp.emit("Target.receivedMessageFromTarget", {
    sessionId: "other",
    message: JSON.stringify({
      method: "Target.detachedFromTarget",
      params: { sessionId: "nested" },
    }),
  });
  await nested;
  await pipe.close();
  await expect(pipe.send("Runtime.evaluate")).rejects.toThrow("closed");
});

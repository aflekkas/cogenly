import { type PreviewEvent, type PreviewSessionSnapshot, ThreadId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withNativeServerTabThread } from "./desktopServerTabThreads.logic";

const agentThread = ThreadId.make("agent-thread");
const openThread = ThreadId.make("open-thread");

const event = (
  type: "opened" | "navigated" | "closed",
  snapshot: Partial<PreviewSessionSnapshot>,
): PreviewEvent =>
  ({
    type,
    threadId: agentThread,
    tabId: "tab-1",
    createdAt: "2026-10-27T19:07:02.000Z",
    serverEpoch: "epoch",
    revision: 1,
    ...(type === "closed" ? {} : { snapshot: { runtime: "server", ...snapshot } }),
  }) as PreviewEvent;

describe("withNativeServerTabThread", () => {
  it("syncs a thread nobody has open once its server opens a native agent tab", () => {
    // The regression: preview_open in a thread off screen waited 10s for a webview.
    const threads = withNativeServerTabThread(
      new Set([openThread]),
      event("opened", { serverRendering: "native" }),
    );
    expect([...threads]).toEqual([openThread, agentThread]);
  });

  it("leaves streamed, desktop and closed tabs to the threads on screen", () => {
    const threads = new Set<ThreadId>();
    expect(withNativeServerTabThread(threads, event("opened", { serverRendering: "stream" }))).toBe(
      threads,
    );
    expect(withNativeServerTabThread(threads, event("opened", { runtime: "desktop" }))).toBe(
      threads,
    );
    expect(withNativeServerTabThread(threads, event("closed", {}))).toBe(threads);
  });

  it("keeps the same set for a thread it already syncs", () => {
    const threads = new Set([agentThread]);
    expect(withNativeServerTabThread(threads, event("navigated", {}))).toBe(threads);
  });
});

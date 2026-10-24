import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  isThreadRouteContentReady,
  resolveThreadRouteHold,
  THREAD_ROUTE_HOLD_MAX_MS,
  threadRouteHoldRemainingMs,
} from "./threadRouteHold";
import type { ThreadRouteTarget } from "./threadRoutes";

function serverThread(threadId: string): ThreadRouteTarget {
  return {
    kind: "server",
    threadRef: { environmentId: "env" as EnvironmentId, threadId: threadId as ThreadId },
  };
}
const a = serverThread("a");
const b = serverThread("b");
const c = serverThread("c");
const draft: ThreadRouteTarget = { kind: "draft", draftId: "draft-1" as DraftId };

const pending = { nextReady: false, expired: false, retained: false };

describe("resolveThreadRouteHold", () => {
  it("keeps the shown thread while the next one loads", () => {
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: b })).toEqual({
      target: a,
      holding: true,
    });
  });

  it("swaps once the next thread is ready or the hold runs out", () => {
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: b, nextReady: true })).toEqual({
      target: b,
      holding: false,
    });
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: b, expired: true })).toEqual({
      target: b,
      holding: false,
    });
  });

  it("follows the latest destination, never a stale one", () => {
    const first = resolveThreadRouteHold({ ...pending, shown: a, next: b });
    const second = resolveThreadRouteHold({ ...pending, shown: first.target, next: c });
    expect(second).toEqual({ target: a, holding: true });
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: c, nextReady: true }).target).toBe(
      c,
    );
  });

  it("never holds for drafts, a first open, a return, or a stand-in view", () => {
    expect(resolveThreadRouteHold({ ...pending, shown: draft, next: b }).holding).toBe(false);
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: draft }).holding).toBe(false);
    expect(resolveThreadRouteHold({ ...pending, shown: null, next: b }).holding).toBe(false);
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: serverThread("a") }).holding).toBe(
      false,
    );
    expect(resolveThreadRouteHold({ ...pending, shown: a, next: b, retained: true }).holding).toBe(
      false,
    );
  });
});

describe("threadRouteHoldRemainingMs", () => {
  it("bounds one hold from when it began", () => {
    expect(threadRouteHoldRemainingMs(1_000, 1_000)).toBe(THREAD_ROUTE_HOLD_MAX_MS);
    expect(threadRouteHoldRemainingMs(1_000, 1_100)).toBe(THREAD_ROUTE_HOLD_MAX_MS - 100);
    expect(threadRouteHoldRemainingMs(1_000, 5_000)).toBe(0);
  });
});

describe("isThreadRouteContentReady", () => {
  const loading = { data: Option.none(), status: "synchronizing" as const, error: Option.none() };
  const shell = { itemCount: 4, latestUserMessageAt: "2026-01-01T00:00:00Z", latestRun: null };

  it("waits for a thread with content that has not loaded", () => {
    expect(isThreadRouteContentReady({ state: loading, shell, hasRememberedTimeline: false })).toBe(
      false,
    );
  });

  it("is ready when loaded, settled, remembered, empty, or unknown", () => {
    expect(
      isThreadRouteContentReady({
        state: { ...loading, data: Option.some({} as never) },
        shell,
        hasRememberedTimeline: false,
      }),
    ).toBe(true);
    expect(
      isThreadRouteContentReady({
        state: { ...loading, status: "deleted" },
        shell,
        hasRememberedTimeline: false,
      }),
    ).toBe(true);
    expect(
      isThreadRouteContentReady({
        state: { ...loading, error: Option.some("offline") },
        shell,
        hasRememberedTimeline: false,
      }),
    ).toBe(true);
    expect(isThreadRouteContentReady({ state: loading, shell, hasRememberedTimeline: true })).toBe(
      true,
    );
    expect(
      isThreadRouteContentReady({
        state: loading,
        shell: { itemCount: 0, latestUserMessageAt: null, latestRun: null },
        hasRememberedTimeline: false,
      }),
    ).toBe(true);
    expect(
      isThreadRouteContentReady({ state: loading, shell: null, hasRememberedTimeline: false }),
    ).toBe(true);
  });
});

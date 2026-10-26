import { expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import { ThreadId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Manager from "./Manager.ts";

it.effect(
  "an unseen agent tab remains available after days of inactivity until explicitly closed",
  () =>
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      const threadId = ThreadId.make("thread:lifetime");
      const opened = yield* manager.open({
        threadId,
        url: "https://example.test/setup",
        runtime: "server",
        reveal: false,
        automationOwner: "agent:1",
      });
      yield* TestClock.adjust("7 days");
      const sessions = (yield* manager.list({ threadId })).sessions;
      expect(sessions.map((tab) => tab.tabId)).toContain(opened.tabId);
      expect(sessions[0]?.navStatus).toEqual(opened.navStatus);
      yield* manager.close({ threadId, tabId: opened.tabId });
      expect((yield* manager.list({ threadId })).sessions).toHaveLength(0);
    }).pipe(Effect.provide(Manager.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

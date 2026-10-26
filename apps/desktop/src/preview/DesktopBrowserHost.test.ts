import { type DesktopBrowserEvent } from "@cogenly/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import * as Host from "./DesktopBrowserHost.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as SitePermissions from "./SitePermissions.ts";
import { SitePermissionsController } from "./SitePermissionsController.ts";
import { SitePermissionStore } from "./SitePermissionStore.ts";

vi.mock("electron", () => ({ BrowserWindow: {}, session: {}, systemPreferences: {}, dialog: {} }));

it.effect("ignores an old endpoint's release and commands after reconnecting the same tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* Host.DesktopBrowserHost;
      const announced = yield* Deferred.make<void>();
      const firstReply = yield* Deferred.make<void>();
      const secondReply = yield* Deferred.make<void>();
      const replies: Array<{ connectionId: string; message: string }> = [];
      let sequence = 0;
      const sendCommand = vi.fn(async (method: string) => {
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "existing-page" } };
        if (method === "Target.attachToTarget") return { sessionId: `real-${++sequence}` };
        return {};
      });
      const debuggee = Object.assign(new NodeEvents.EventEmitter(), { sendCommand });
      const key = { threadId: "thread", tabId: "tab" };
      host.attach(key, {
        debugger: debuggee,
        webContents: {
          getURL: () => "https://example.test",
          getTitle: () => "Signed in",
          getUserAgent: () => "Chrome",
        },
      } as unknown as Parameters<typeof host.attach>[1]);
      yield* host.events.pipe(
        Stream.runForEach((bytes) => {
          const event = JSON.parse(new TextDecoder().decode(bytes)) as DesktopBrowserEvent;
          if (event.type === "attached") return Deferred.succeed(announced, undefined);
          if (event.type !== "cdp") return Effect.void;
          replies.push(event);
          const message = JSON.parse(event.message) as { id?: number };
          if (message.id === 1) return Deferred.succeed(firstReply, undefined);
          if (message.id === 2) return Deferred.succeed(secondReply, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(announced);
      const command = (value: object) =>
        host.handleCommandLine(JSON.stringify({ ...key, ...value }));
      yield* command({ type: "connect", connectionId: "old" });
      yield* command({
        type: "cdp",
        connectionId: "old",
        message: JSON.stringify({ id: 1, method: "Target.setAutoAttach" }),
      });
      yield* Deferred.await(firstReply);
      yield* command({ type: "connect", connectionId: "new" });
      yield* command({ type: "release", connectionId: "old" });
      yield* command({
        type: "cdp",
        connectionId: "old",
        message: JSON.stringify({ id: 3, method: "Target.setAutoAttach" }),
      });
      yield* command({
        type: "cdp",
        connectionId: "new",
        message: JSON.stringify({ id: 2, method: "Target.setAutoAttach" }),
      });
      yield* Deferred.await(secondReply);
      expect(sequence).toBe(2);
      expect(
        replies.some((reply) => reply.connectionId === "new" && JSON.parse(reply.message).id === 2),
      ).toBe(true);
      expect(replies.some((reply) => JSON.parse(reply.message).id === 3)).toBe(false);
      expect(
        sendCommand.mock.calls.some(
          ([method]) => method === "Page.reload" || method === "Target.closeTarget",
        ),
      ).toBe(false);
      host.detach(key);
    }),
  ).pipe(
    Effect.provide(
      Host.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(BrowserSession.BrowserSession)({
              isPartition: () => false,
              partitionOf: () => undefined,
            }),
            Layer.succeed(SitePermissions.SitePermissions, {
              controller: new SitePermissionsController(
                new SitePermissionStore(null, { isPersistent: () => false, onChange: () => {} }),
                () => "prompt",
              ),
            }),
          ),
        ),
      ),
    ),
  ),
);

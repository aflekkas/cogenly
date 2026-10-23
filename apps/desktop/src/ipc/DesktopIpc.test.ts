import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";

type InvokeListener = (
  event: DesktopIpc.DesktopIpcInvokeEvent,
  raw: unknown,
) => unknown | Promise<unknown>;
type SyncListener = (event: DesktopIpc.DesktopIpcSyncEvent) => void;

function fakeIpcMain() {
  const invoke = new Map<string, InvokeListener>();
  const sync = new Map<string, SyncListener>();
  const ipcMain: DesktopIpc.DesktopIpcMain = {
    removeHandler: (channel) => void invoke.delete(channel),
    handle: (channel, listener) => void invoke.set(channel, listener),
    removeAllListeners: (channel) => void sync.delete(channel),
    on: (channel, listener) => void sync.set(channel, listener),
  };
  return { ipcMain, invoke, sync };
}

const mainFrame = { name: "main" };
const subFrame = { name: "sub" };
const mainFrameEvent: DesktopIpc.DesktopIpcInvokeEvent = {
  sender: { id: 1, mainFrame },
  senderFrame: mainFrame,
};
const subFrameEvent: DesktopIpc.DesktopIpcInvokeEvent = {
  sender: { id: 1, mainFrame },
  senderFrame: subFrame,
};

describe("DesktopIpc frame guard", () => {
  it.effect("invokes the handler for the main frame and rejects a subframe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeIpcMain();
        const ipc = DesktopIpc.make(fake.ipcMain);
        let calls = 0;
        yield* ipc.handle({
          channel: "test:invoke",
          handler: () =>
            Effect.sync(() => {
              calls += 1;
              return "ok";
            }),
        });
        const listener = fake.invoke.get("test:invoke");
        expect(listener).toBeDefined();
        const ok = yield* Effect.promise(() => Promise.resolve(listener!(mainFrameEvent, null)));
        expect(ok).toBe("ok");
        expect(calls).toBe(1);
        const rejected = yield* Effect.result(
          Effect.tryPromise({
            try: () => Promise.resolve(listener!(subFrameEvent, null)),
            catch: (cause) => (cause instanceof Error ? cause.message : "rejected"),
          }),
        );
        expect(rejected._tag).toBe("Failure");
        expect(calls).toBe(1);
      }),
    ),
  );

  it.effect("answers sync handlers for the main frame only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeIpcMain();
        const ipc = DesktopIpc.make(fake.ipcMain);
        yield* ipc.handleSync({
          channel: "test:sync",
          handler: () => Effect.succeed("sync-ok"),
        });
        const listener = fake.sync.get("test:sync");
        expect(listener).toBeDefined();
        const mainEvent: DesktopIpc.DesktopIpcSyncEvent = {
          returnValue: undefined,
          sender: { mainFrame },
          senderFrame: mainFrame,
        };
        listener!(mainEvent);
        expect(mainEvent.returnValue).toBe("sync-ok");
        const subEvent: DesktopIpc.DesktopIpcSyncEvent = {
          returnValue: undefined,
          sender: { mainFrame },
          senderFrame: subFrame,
        };
        listener!(subEvent);
        expect(subEvent.returnValue).toBeUndefined();
      }),
    ),
  );
});

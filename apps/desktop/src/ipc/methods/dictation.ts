import {
  DesktopDictationResultSchema,
  DesktopDictationStreamInputSchema,
  DesktopMicrophoneAccessSchema,
  type DesktopDictationStreamEvent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// About a second of 16 kHz PCM16; the renderer sends a tenth of that per chunk.
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;

export const isAvailable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_IS_AVAILABLE_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.dictation.isAvailable")(function* () {
    return yield* (yield* DesktopDictation.DesktopDictation).isAvailable;
  }),
});

export const requestMicrophoneAccess = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_REQUEST_MICROPHONE_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopMicrophoneAccessSchema,
  handler: Effect.fn("desktop.ipc.dictation.requestMicrophoneAccess")(function* () {
    return yield* (yield* DesktopDictation.DesktopDictation).requestMicrophoneAccess;
  }),
});

export const startStream = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_STREAM_START_CHANNEL,
  payload: DesktopDictationStreamInputSchema,
  result: DesktopDictationResultSchema,
  handler: Effect.fn("desktop.ipc.dictation.startStream")(function* (input, event) {
    const dictation = yield* DesktopDictation.DesktopDictation;
    const contents = event ? Electron.webContents.fromId(event.sender.id) : undefined;
    if (!contents) return { ok: false, code: "cancelled", message: "The window closed." } as const;
    // A closed or reloaded window cannot stop its run, so its run stops with it.
    const runFork = Effect.runForkWith(yield* Effect.context());
    const stopWithWindow = () => void runFork(dictation.cancel(input.requestId));
    const onNavigation = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      // In-page route changes keep the document, and its run, alive.
      if (isMainFrame && !isInPlace) stopWithWindow();
    };
    contents.once("destroyed", stopWithWindow);
    contents.on("did-start-navigation", onNavigation);
    return yield* dictation
      .stream(input, (body) => {
        if (contents.isDestroyed()) return;
        const payload = { requestId: input.requestId, ...body } as DesktopDictationStreamEvent;
        contents.send(IpcChannels.DICTATION_STREAM_EVENT_CHANNEL, payload);
      })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (contents.isDestroyed()) return;
            contents.removeListener("destroyed", stopWithWindow);
            contents.removeListener("did-start-navigation", onNavigation);
          }),
        ),
      );
  }),
});

export const finishStream = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_STREAM_FINISH_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.finishStream")(function* (requestId) {
    yield* (yield* DesktopDictation.DesktopDictation).finishStream(requestId);
  }),
});

export const cancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_CANCEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.cancel")(function* (requestId) {
    yield* (yield* DesktopDictation.DesktopDictation).cancel(requestId);
  }),
});

export const methods = [
  isAvailable,
  requestMicrophoneAccess,
  startStream,
  finishStream,
  cancel,
] as const;

/**
 * Audio is a one-way `send`, not an invoke: a dozen round trips a second would
 * only add latency. Registered for the handlers' scope.
 */
export const registerStreamAudio = Effect.gen(function* () {
  const dictation = yield* DesktopDictation.DesktopDictation;
  const onAudio = (_event: Electron.IpcMainEvent, requestId: unknown, audio: unknown) => {
    if (typeof requestId !== "string" || !(audio instanceof Uint8Array)) return;
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_CHUNK_BYTES) return;
    dictation.streamAudio(requestId, audio);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => Electron.ipcMain.on(IpcChannels.DICTATION_STREAM_AUDIO_CHANNEL, onAudio)),
    () =>
      Effect.sync(() =>
        Electron.ipcMain.removeListener(IpcChannels.DICTATION_STREAM_AUDIO_CHANNEL, onAudio),
      ),
  );
});

import {
  DesktopDictationPrepareInputSchema,
  DesktopDictationResultSchema,
  DesktopDictationTranscribeInputSchema,
  DesktopMicrophoneAccessSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

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

export const prepare = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_PREPARE_CHANNEL,
  payload: DesktopDictationPrepareInputSchema,
  result: DesktopDictationResultSchema,
  handler: Effect.fn("desktop.ipc.dictation.prepare")(function* (input) {
    return yield* (yield* DesktopDictation.DesktopDictation).prepare(input);
  }),
});

export const transcribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_TRANSCRIBE_CHANNEL,
  payload: DesktopDictationTranscribeInputSchema,
  result: DesktopDictationResultSchema,
  handler: Effect.fn("desktop.ipc.dictation.transcribe")(function* (input) {
    return yield* (yield* DesktopDictation.DesktopDictation).transcribe(input);
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

export const methods = [isAvailable, requestMicrophoneAccess, prepare, transcribe, cancel] as const;

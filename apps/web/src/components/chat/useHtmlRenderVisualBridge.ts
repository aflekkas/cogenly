import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, VisualState } from "@t3tools/contracts";
import {
  type HtmlRenderVisualSnapshot,
  htmlRenderResult,
  htmlRenderVisualError,
  htmlRenderVisualStateChangedMessage,
} from "@t3tools/shared/htmlRender";
import { Atom } from "effect/reactivity";
import { type RefObject, useEffect, useEffectEvent, useRef } from "react";

import { visualStateRpc } from "~/rpc/visualState";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { environmentThreadDetails } from "~/state/threads";

import {
  isVisualSnapshotNews,
  readVisualBridgeRequest,
  visualBridgeErrorReply,
  visualSnapshot,
} from "./htmlRenderVisualBridge";

const NO_VISUAL_STATE = Atom.make<VisualState | null>(null).pipe(
  Atom.withLabel("html-render-visual-state:none"),
);
const NO_PERMISSION = Atom.make(false).pipe(Atom.withLabel("html-render-visual-permission:none"));

/** A render's stored document from the thread projection, or null before its first write. */
export function useHtmlRenderVisualState(
  threadRef: ScopedThreadRef | undefined,
  renderId: string | undefined,
) {
  return useAtomValue(
    threadRef === undefined || renderId === undefined
      ? NO_VISUAL_STATE
      : environmentThreadDetails.visualStateAtom(threadRef, renderId),
  );
}

/**
 * Answers a framed render's `window.cogenly` requests with the thread's
 * stored document for `renderId`, and pushes every change into the frame.
 * Each mounted frame (inline, full screen, file preview) runs its own bridge
 * and follows the same projection entry, so they stay in sync.
 */
export function useHtmlRenderVisualBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  visual: {
    readonly threadRef: ScopedThreadRef | undefined;
    readonly renderId: string | undefined;
    readonly title: string;
  },
) {
  const { threadRef, renderId, title } = visual;
  const stored = useHtmlRenderVisualState(threadRef, renderId);
  const canWrite = useAtomValue(
    threadRef === undefined
      ? NO_PERMISSION
      : visualStateRpc.set.permissionAtom(threadRef.environmentId),
  );
  const get = useAtomCommand(visualStateRpc.get, { reportFailure: false });
  const set = useOrchestrationCommand(visualStateRpc.set, { reportFailure: false });
  const submit = useOrchestrationCommand(visualStateRpc.submit, { reportFailure: false });
  // The version and lock this frame's page last heard, from a reply or a push.
  const seen = useRef<HtmlRenderVisualSnapshot | null>(null);

  const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*");
  const push = useEffectEvent((snapshot: HtmlRenderVisualSnapshot) => {
    if (!isVisualSnapshotNews(seen.current, snapshot)) return;
    seen.current = snapshot;
    post(htmlRenderVisualStateChangedMessage(snapshot));
  });
  useEffect(() => {
    if (stored !== null) push(visualSnapshot(stored));
  }, [stored]);

  const handle = useEffectEvent(async (data: unknown) => {
    const request = readVisualBridgeRequest(data);
    if (request === undefined) return;
    if (threadRef === undefined || renderId === undefined) {
      post(htmlRenderVisualError(request.id, "unavailable", "This page is not shown in a thread."));
      return;
    }
    if (request.kind !== "get" && !canWrite) {
      post(
        htmlRenderVisualError(request.id, "unavailable", "This connection cannot change threads."),
      );
      return;
    }
    const target = { environmentId: threadRef.environmentId };
    const ids = { threadId: threadRef.threadId, renderId };
    const failed = (result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>) =>
      post(
        isAtomCommandInterrupted(result)
          ? htmlRenderVisualError(request.id, "unavailable", "The visual request was cancelled.")
          : visualBridgeErrorReply(request.id, squashAtomCommandFailure(result)),
      );
    switch (request.kind) {
      case "get": {
        const result = await get({ ...target, input: ids });
        if (result._tag === "Failure") return failed(result);
        const snapshot = visualSnapshot(result.value.state);
        if (isVisualSnapshotNews(seen.current, snapshot)) seen.current = snapshot;
        post(htmlRenderResult(request.id, snapshot));
        return;
      }
      case "set": {
        const result = await set({
          ...target,
          input: { ...ids, title, state: request.state, expectedVersion: request.expectedVersion },
        });
        if (result._tag === "Failure") return failed(result);
        post(htmlRenderResult(request.id, { version: result.value.version }));
        push(visualSnapshot(result.value));
        return;
      }
      case "submit": {
        const result = await submit({
          ...target,
          input: { ...ids, title, payload: request.payload, lock: request.lock },
        });
        if (result._tag === "Failure") return failed(result);
        post(htmlRenderResult(request.id, {}));
        push(visualSnapshot(result.value.state));
        return;
      }
    }
  });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      void handle(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef]);
}

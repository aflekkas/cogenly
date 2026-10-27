import type { EnvironmentRpcRequestObservation } from "@cogenly/client-runtime/rpc";
import type { LatencyAction } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import type * as Tracer from "effect/Tracer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  beginActionIfAbsent,
  finishAction,
  linkAction,
  recordActionDuration,
} from "../observability/actionLatency";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "./requestLatencyState";

let nextObservedRpcRequestId = 0;

export const observeRpcRequest = ({
  environmentId,
  method,
  input,
  remote,
}: EnvironmentRpcRequestObservation) =>
  Effect.gen(function* () {
    const parent = yield* Effect.currentSpan.pipe(Effect.option);
    const startedAt = performance.now();
    let action: LatencyAction | null = null;
    let ancestor: Tracer.AnySpan | null = Option.getOrNull(parent);
    let stopping = false;
    for (let depth = 0; ancestor?._tag === "Span" && depth < 8; depth++) {
      if (ancestor.name === "EnvironmentCommands.interruptThreadTurn") stopping = true;
      ancestor = Option.getOrNull(ancestor.parent);
    }
    const stopKey =
      stopping && Predicate.isObject(input) && typeof input.threadId === "string"
        ? `${environmentId}:${input.threadId}`
        : null;
    if (stopKey !== null) {
      beginActionIfAbsent("turn.stop", stopKey);
      if (Option.isSome(parent)) linkAction("turn.stop", stopKey, parent.value);
    }

    if (
      method === "orchestration.launchThread" &&
      Predicate.isObject(input) &&
      Predicate.isObject(input.initialMessage)
    ) {
      action = "message.ack";
      const messageId = input.initialMessage.messageId;
      if (typeof messageId === "string" && Option.isSome(parent))
        linkAction("message.send", `${environmentId}:${messageId}`, parent.value);
    }
    if (method === "orchestration.shellSnapshot") {
      action = "threads.load";
      if (Option.isSome(parent)) linkAction("threads.load", "", parent.value);
    }
    if (method === "orchestration.threadBoundedSnapshot" && Predicate.isObject(input)) {
      action = "thread.open";
      if (typeof input.threadId === "string" && Option.isSome(parent))
        linkAction("thread.open", `${environmentId}:${input.threadId}`, parent.value);
    }
    if (method === "server.getSettings") action = "settings.load";
    if (method === "orchestration.dispatchCommand" && Predicate.isObject(input)) {
      if (input.type === "message.dispatch") action = "message.ack";
      if (input.type === "run.interrupt") action = "turn.stop";
      if (typeof input.messageId === "string" && Option.isSome(parent)) {
        for (const name of ["message.send", "message.queue"] as const)
          linkAction(name, `${environmentId}:${input.messageId}`, parent.value);
      }
    }

    nextObservedRpcRequestId += 1;
    const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
    trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
    return (exit: Exit.Exit<unknown, unknown>) =>
      Effect.sync(() => {
        acknowledgeRpcRequest(requestId);
        const outcome = Exit.isSuccess(exit) ? "success" : "failure";
        if (stopKey !== null && outcome === "failure") finishAction("turn.stop", stopKey, outcome);
        const links = Option.isSome(parent) ? [{ span: parent.value, attributes: {} }] : [];
        if (action) recordActionDuration(action, startedAt, "ack", outcome, links);
        if (remote) recordActionDuration("rpc.remote", startedAt, "ack", outcome, links);
      });
  });

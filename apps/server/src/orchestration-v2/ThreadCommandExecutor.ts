import type { ThreadId } from "@cogenly/contracts";
import * as KeyedLock from "@cogenly/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("cogenly-server/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());

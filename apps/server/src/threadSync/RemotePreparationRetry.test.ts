import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ServerProvider } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import { makeProviderFailure } from "@cogenly/provider-core/server/failure";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import { pair } from "../machines/testkit.ts";
import { startThreadMachine, threadCreated, threadId } from "./testkit.ts";

const providers = [
  Schema.decodeUnknownSync(ServerProvider)({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5",
        name: "GPT-5",
        isCustom: false,
        capabilities: null,
        isDefault: true,
      },
    ],
  }),
];

it.live.each([false, true])(
  "a remote preparation retry runs on its owner (setup fails: %s)",
  (fails) =>
    Effect.gen(function* () {
      const setups: string[] = [];
      const options = (name: string) => ({
        providers,
        git: {
          forkSource: () => Effect.die("Unexpected fork"),
          forkCheckout: () => Effect.die("Unexpected fork"),
        },
        setup: (input: Setup.ProjectSetupScriptRunnerInput) =>
          Effect.gen(function* () {
            setups.push(name);
            if (fails)
              return yield* new Setup.ProjectSetupScriptOperationError({
                threadId: input.threadId,
                worktreePath: input.worktreePath,
                operation: "openTerminal",
                cause: new Error("Setup unavailable"),
              });
            return { status: "no-script" as const };
          }),
      });
      const owner = yield* startThreadMachine(
        `retry-owner-${fails}`,
        "cloud-server",
        undefined,
        undefined,
        true,
        options("owner"),
      );
      const caller = yield* startThreadMachine(
        `retry-caller-${fails}`,
        "computer",
        undefined,
        undefined,
        true,
        options("caller"),
      );
      yield* pair(owner, caller);
      const created = threadCreated("event:retry-thread", yield* DateTime.now);
      if (created.type !== "thread.created") return yield* Effect.die("Expected thread");
      yield* owner.sink.write({ events: [created] });
      for (const machine of [owner, caller]) {
        yield* machine.sql`INSERT INTO projection_projects(project_id,title,workspace_root,auto_pull,scripts_json,created_at,updated_at)
          VALUES (${created.payload.projectId}, 'Test', ${process.cwd()}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
      }
      const engine = Option.getOrThrow(owner.engine);
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("retry:message"),
        threadId,
        messageId: MessageId.make("message:retry"),
        text: "Run this",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
      });
      const run = (yield* owner.projections.getThreadProjection(threadId)).runs[0]!;
      yield* engine.dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make("retry:initial-fail"),
        threadId,
        runId: run.id,
        failure: makeProviderFailure({
          message: "Initial setup failed",
          class: "validation_error",
          retryable: false,
        }),
      });
      yield* owner.sync.sync(caller.environmentId);
      const afterSequence = yield* owner.sink.latestSequence({ threadId });
      yield* caller.launch.retryPreparation({
        commandId: CommandId.make("retry:again"),
        threadId,
        runId: run.id,
      });
      yield* Effect.raceFirst(owner.preparationFinished, caller.preparationFinished);
      expect(setups).toEqual(["owner"]);
      yield* Stream.runHead(
        owner.sink
          .stream({ threadId, afterSequence, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === run.id &&
                stored.event.payload.status !== "preparing",
            ),
          ),
      );
      yield* Option.getOrThrow(owner.worker).drain();
      yield* owner.sync.sync(caller.environmentId);
      const result = yield* caller.projections.getThreadProjection(threadId);
      expect(result.runs[0]?.status).toBe(fails ? "failed" : "running");
      expect(result.runs[0]?.completedAt === null).toBe(!fails);
      expect(caller.provider.turns).toHaveLength(0);
      expect(owner.provider.turns).toHaveLength(fails ? 0 : 1);
    }).pipe(Effect.scoped),
  30000,
);

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@cogenly/contracts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@cogenly/provider-core/server/McpProviderSessions";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { claudeProjectDirName } from "../../provider/Drivers/ClaudeHome.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };

interface FakeClaudeOptions {
  /** Where the fake CLI writes the transcripts of the sessions it creates. */
  readonly transcriptConfigDir: string;
  /** Answer every `--resume` with "No conversation found". */
  readonly refuseResume: boolean;
  /** Fail the first prompt of every fresh session, as a second failure would. */
  readonly failFreshSessionsAfter?: number;
}

interface FakeOpen {
  readonly sessionId: string | undefined;
  readonly resume: string | undefined;
  readonly prompts: Array<string>;
}

let resultCount = 0;
const resultMessage = (input: {
  readonly sessionId: string;
  readonly promptUuid: string | undefined;
  readonly error?: string;
}) =>
  ({
    type: "result",
    subtype: input.error === undefined ? "success" : "error_during_execution",
    is_error: input.error !== undefined,
    ...(input.error === undefined ? { result: "ok" } : { errors: [input.error] }),
    ...(input.promptUuid === undefined ? {} : { user_message_uuid: input.promptUuid }),
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: input.error === undefined ? 1 : 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
    session_id: input.sessionId,
    uuid: `result-${++resultCount}`,
  }) as unknown as SDKMessage;

const promptText = (message: SDKUserMessage): string => {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

/**
 * A Claude CLI stand-in: each open is one process that answers one prompt and
 * exits, so every later turn resumes. New sessions write a transcript where a
 * real CLI would, under `transcriptConfigDir` for the process cwd.
 */
const makeFakeClaude = (options: FakeClaudeOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const opens: Array<FakeOpen> = [];
    let nextSessionId = 1;
    let freshSessions = 0;
    const queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape = {
      allocateSessionId: Effect.sync(() => `00000000-0000-4000-8000-00000000000${nextSessionId++}`),
      open: (input) =>
        Effect.gen(function* () {
          const sessionId = input.options.sessionId;
          const resume = input.options.resume;
          const record: FakeOpen = { sessionId, resume, prompts: [] };
          opens.push(record);
          const fresh = sessionId !== undefined;
          if (fresh) freshSessions += 1;
          const failThisSession =
            fresh &&
            options.failFreshSessionsAfter !== undefined &&
            freshSessions > options.failFreshSessionsAfter;
          if (fresh && input.options.cwd !== undefined) {
            const dir = path.join(
              options.transcriptConfigDir,
              "projects",
              claudeProjectDirName(input.options.cwd),
            );
            yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
            yield* fs
              .writeFileString(path.join(dir, `${sessionId}.jsonl`), "{}\n")
              .pipe(Effect.orDie);
          }
          const queue = yield* Queue.unbounded<SDKMessage, Cause.Done>();
          const nativeId = sessionId ?? resume ?? "unknown";
          return {
            messages: Stream.fromQueue(queue),
            offer: (message: SDKUserMessage) =>
              Effect.gen(function* () {
                record.prompts.push(promptText(message));
                const refused = resume !== undefined && options.refuseResume;
                yield* Queue.offer(
                  queue,
                  resultMessage({
                    sessionId: nativeId,
                    promptUuid: refused ? undefined : message.uuid,
                    ...(refused
                      ? { error: `No conversation found with session ID: ${nativeId}` }
                      : failThisSession
                        ? { error: "Claude could not start the fresh session" }
                        : {}),
                  }),
                );
                yield* Queue.end(queue);
              }),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            stopTask: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            interrupt: Effect.void,
            close: Queue.end(queue).pipe(Effect.asVoid),
          } satisfies ClaudeAdapter.ClaudeAgentSdkQuerySession;
        }),
      forkSession: () => Effect.die("unexpected fork"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    };
    return { queryRunner, opens };
  });

const makeAdapter = (input: {
  readonly home: string;
  readonly queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape;
  readonly environment?: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    return yield* ClaudeAdapter.makeClaudeAdapterV2({
      instanceId,
      settings: yield* decodeClaudeSettings({}),
      // The instance's own config dir is HOME/.claude unless CLAUDE_CONFIG_DIR says otherwise.
      environment: { HOME: input.home, ...input.environment },
      attachmentsDir: input.home,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: input.queryRunner,
    });
  });

const threadId = ThreadId.make("thread:missing-session");

const sendMessage = (key: string, text: string): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`send:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
});

/** Two turns of one chat through the real orchestrator and Claude adapter. */
const runTwoTurns = (options: Omit<FakeClaudeOptions, "transcriptConfigDir">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-claude-missing-" }),
    );
    const cwd = path.join(root, "chat");
    yield* fs.makeDirectory(cwd, { recursive: true });
    const fake = yield* makeFakeClaude({
      ...options,
      transcriptConfigDir: path.join(root, ".claude"),
    });
    const layerRegistry = Layer.effect(
      Registry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const adapter = yield* makeAdapter({ home: root, queryRunner: fake.queryRunner });
        return Registry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([instanceId]),
          getMetadata: () =>
            Effect.succeed({
              driver: ClaudeAdapter.CLAUDE_PROVIDER,
              continuationKey: "claude",
              enabled: true,
              capabilities: ClaudeAdapter.ClaudeProviderCapabilitiesV2,
            }),
          get: () => Effect.succeed(adapter),
        });
      }),
    ).pipe(Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer)));
    const database = Sqlite.layerMemory;
    const create: OrchestrationV2Command = {
      type: "thread.create",
      commandId: CommandId.make("create:missing-session"),
      threadId,
      projectId: ProjectId.make("project:missing-session"),
      title: "Missing session",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    };
    const result = yield* runOrchestratorV2Scenario({
      name: "claude-missing-session",
      commands: [],
      steps: [
        { type: "dispatch", command: create },
        { type: "dispatch", command: sendMessage("first", "Remember the word heliotrope.") },
        { type: "await_thread_idle", threadId },
        { type: "dispatch", command: sendMessage("second", "Which word did I ask for?") },
        { type: "await_thread_idle", threadId },
      ],
      projectionThreadIds: [threadId],
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          database,
          layerWithRegistry({ name: "claude-missing-session" }, layerRegistry, {
            databaseLayer: database,
          }),
        ),
      ),
    );
    const projection = result.projections.get(threadId)!;
    return { projection, opens: fake.opens };
  }).pipe(Effect.scoped);

const errorItemsOf = (projection: OrchestrationV2ThreadProjection, runOrdinal: number) => {
  const run = projection.runs.find((candidate) => candidate.ordinal === runOrdinal);
  return projection.turnItems.filter((item) => item.runId === run?.id && item.type === "error");
};

describe("Claude session missing on resume", () => {
  it.effect("retries once in a fresh seeded session when Claude refuses the resume", () =>
    Effect.gen(function* () {
      const { projection, opens } = yield* runTwoTurns({
        refuseResume: true,
      });
      const first = opens[0]!.sessionId!;
      assert.deepEqual(
        opens.map((open) => ({ fresh: open.sessionId !== undefined, resume: open.resume })),
        [
          { fresh: true, resume: undefined },
          { fresh: false, resume: first },
          { fresh: true, resume: undefined },
        ],
      );
      const replacement = opens[2]!.sessionId!;
      assert.notEqual(replacement, first);
      // The retried prompt carries the conversation so far.
      assert.include(opens[2]!.prompts[0], "heliotrope");
      assert.include(opens[2]!.prompts[0], "Which word did I ask for?");
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.lengthOf(errorItemsOf(projection, 2), 0);
      // The thread and the run's attempt now point at the replacement, so the
      // next turn resumes it rather than the refused session.
      const claudeThread = projection.providerThreads.find(
        (thread) => thread.providerInstanceId === instanceId,
      );
      assert.equal(claudeThread?.nativeThreadRef?.nativeId, replacement);
      const secondRun = projection.runs.find((run) => run.ordinal === 2)!;
      const attempt = projection.attempts.find((entry) => entry.id === secondRun.activeAttemptId);
      assert.equal(attempt?.nativeThreadId, replacement);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces the error when the fresh session fails too", () =>
    Effect.gen(function* () {
      const { projection, opens } = yield* runTwoTurns({
        refuseResume: true,
        failFreshSessionsAfter: 1,
      });
      // One retry only.
      assert.lengthOf(opens, 3);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "failed"],
      );
      assert.isAbove(errorItemsOf(projection, 2).length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("ClaudeAdapterV2 resumeThread", () => {
  // A session created in `scratch` under ~/.claude, then resumed by an
  // instance in `cwd` running with `configDir`.
  const resumeCreatedSession = (input: {
    readonly cwd: "scratch" | "project";
    readonly configDir: ".claude" | ".claude_personal";
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-claude-resume-" }),
      );
      const scratch = path.join(root, "scratch");
      yield* fs.makeDirectory(scratch, { recursive: true });
      yield* fs.makeDirectory(path.join(root, "project"), { recursive: true });
      const fake = yield* makeFakeClaude({
        transcriptConfigDir: path.join(root, ".claude"),
        refuseResume: false,
      });
      const adapter = yield* makeAdapter({
        home: root,
        queryRunner: fake.queryRunner,
        // The server was relaunched from a shell that exported another account.
        ...(input.configDir === ".claude"
          ? {}
          : { environment: { CLAUDE_CONFIG_DIR: path.join(root, input.configDir) } }),
      });
      const runtimePolicy = (cwd: string) => ({
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: "provider-session:resume" as never,
        modelSelection,
        runtimePolicy: runtimePolicy(scratch),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy(scratch),
      });
      const nativeId = providerThread.nativeThreadRef!.nativeId!;
      const transcriptDir = path.join(root, ".claude", "projects", claudeProjectDirName(scratch));
      yield* fs.makeDirectory(transcriptDir, { recursive: true });
      yield* fs.writeFileString(path.join(transcriptDir, `${nativeId}.jsonl`), "{}\n");
      return yield* session
        .resumeThread({ providerThread, runtimePolicy: runtimePolicy(path.join(root, input.cwd)) })
        .pipe(Effect.result);
    }).pipe(
      Effect.scoped,
      Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer]),
    );

  const assertNativeThreadMissing = (
    result: Effect.Success<ReturnType<typeof resumeCreatedSession>>,
  ) => {
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "ProviderAdapterResumeThreadError");
      assert.equal(
        (result.failure.cause as { readonly _tag?: string } | undefined)?._tag,
        "ProviderAdapterNativeThreadMissingError",
      );
    }
  };

  it.effect("resumes a session from the cwd and account that created it", () =>
    Effect.gen(function* () {
      const result = yield* resumeCreatedSession({ cwd: "scratch", configDir: ".claude" });
      assert.equal(result._tag, "Success");
    }),
  );

  it.effect("refuses a session after the chat moved to another cwd", () =>
    Effect.gen(function* () {
      assertNativeThreadMissing(
        yield* resumeCreatedSession({ cwd: "project", configDir: ".claude" }),
      );
    }),
  );

  it.effect("refuses a session after the instance switched config dir", () =>
    Effect.gen(function* () {
      assertNativeThreadMissing(
        yield* resumeCreatedSession({ cwd: "scratch", configDir: ".claude_personal" }),
      );
    }),
  );
});

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TerminalEvent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Reactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as Git from "../git/GitManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as PullRequests from "./PullRequestService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Links from "./ThreadPullRequestLinks.ts";

const projectId = ProjectId.make("repo:pr-link");
const threadId = ThreadId.make("thread:pr-link");
const url = "https://github.com/acme/app/pull/42";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'App','/repos/app','[]','2026-01-01','2026-01-01')`;
  const engine = yield* Orchestrator.OrchestratorV2;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
const runtime = () => {
  const database = Sqlite.layerMemory;
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return layerWithRegistry({ name: "shell-pr-link" }, provider.registry, {
    databaseLayer: database,
    runEffectWorker: false,
  }).pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer));
};

it.effect("duplicate command results preserve every stack link and cannot undo a user unlink", () =>
  Effect.gen(function* () {
    yield* seed;
    const links = yield* Links.ThreadPullRequestLinks;
    const engine = yield* Orchestrator.OrchestratorV2;
    const command = { threadId, commandId: "shell-42", command: "gh pr create", output: url };
    yield* links.linkCreated(command);
    yield* links.linkCreated({
      ...command,
      commandId: "shell-43",
      output: "https://github.com/acme/app/pull/43",
    });
    expect(
      (yield* engine.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
    ).toEqual([42, 43]);
    yield* links.linkCreated(command);
    expect((yield* engine.getThreadShell(threadId))?.pullRequests).toHaveLength(2);
    yield* engine.dispatch({
      type: "thread.pull-request.unlink",
      commandId: CommandId.make("unlink-42"),
      threadId,
      host: "github.com",
      repository: "acme/app",
      number: 42,
    });
    yield* links.linkCreated(command);
    expect(
      (yield* engine.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
    ).toEqual([43]);
    // A later explicit request is a new command and can restore the link.
    yield* links.link({
      threadId,
      commandId: CommandId.make("explicit-link"),
      target: { host: "github.com", repository: "acme/app", number: 42, url },
      source: "agent",
    });
    expect((yield* engine.getThreadShell(threadId))?.pullRequests).toHaveLength(2);
  }).pipe(Effect.provide(Links.layer.pipe(Layer.provideMerge(runtime())))),
);

it.effect("terminal_run links a background creation even when a later command fails", () => {
  let onEvent: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
  const terminalId = "agent-create-pr";
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(Projections.ProjectionStoreV2)({
      getThreadsWithPullRequests: () => Effect.succeed([]),
    }),
    Layer.mock(Git.GitManager)({
      subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
    }),
    Layer.mock(PullRequests.PullRequestService)({
      subscribeStateChanges: Effect.succeed(Stream.empty),
    }),
    Layer.mock(Terminals.TerminalManager)({
      subscribe: (listener) =>
        Effect.sync(() => {
          onEvent = listener;
          return () => {
            onEvent = undefined;
          };
        }),
      listAgents: () =>
        Effect.succeed([
          {
            threadId,
            terminalId,
            command: "gh pr create --title 'Fix app' && false",
            cwd: "/repos/app",
            worktreePath: null,
            status: "exited",
            pid: null,
            exitCode: 1,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "gh pr create",
            updatedAt: "2026-01-01",
          },
        ]),
      readAgent: () =>
        Effect.succeed({
          terminalId,
          status: "exited",
          exitCode: 1,
          timedOut: false,
          output: `${url}\n`,
          nextOffset: url.length + 1,
          truncated: false,
        }),
    }),
  );
  return Effect.gen(function* () {
    yield* seed;
    const reactor = yield* Reactor.PullRequestSyncReactor;
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* reactor.start();
    expect(onEvent).toBeDefined();
    yield* onEvent!({ type: "exited", threadId, terminalId, exitCode: 1, exitSignal: null });
    yield* reactor.drain;
    expect((yield* engine.getThreadShell(threadId))?.pullRequests).toMatchObject([
      { number: 42, source: "created", url },
    ]);
    yield* engine.dispatch({
      type: "thread.pull-request.unlink",
      commandId: CommandId.make("unlink-terminal"),
      threadId,
      host: "github.com",
      repository: "acme/app",
      number: 42,
    });
    yield* onEvent!({ type: "exited", threadId, terminalId, exitCode: 1, exitSignal: null });
    yield* reactor.drain;
    expect((yield* engine.getThreadShell(threadId))?.pullRequests).toEqual([]);
  }).pipe(
    Effect.provide(Reactor.layer.pipe(Layer.provide(dependencies), Layer.provideMerge(runtime()))),
    Effect.scoped,
  );
});

it.effect("a completed provider command item links its PR through the same persisted service", () =>
  Effect.gen(function* () {
    yield* seed;
    const engine = yield* Orchestrator.OrchestratorV2;
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(Orchestrator.OrchestratorV2, {
        ...engine,
        streamDomainEvents: Stream.fromQueue(events),
      }),
      Layer.mock(Projections.ProjectionStoreV2)({
        getThreadsWithPullRequests: () => Effect.succeed([]),
      }),
      Layer.mock(Git.GitManager)({
        subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(PullRequests.PullRequestService)({
        subscribeStateChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(Terminals.TerminalManager)({ subscribe: () => Effect.succeed(() => {}) }),
    );
    yield* Effect.gen(function* () {
      const reactor = yield* Reactor.PullRequestSyncReactor;
      yield* reactor.start();
      const afterSequence = yield* engine.getThreadEventSequence(threadId);
      const now = yield* DateTime.now;
      yield* Queue.offer(events, {
        id: EventId.make("native-command"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("native-create-pr"),
          type: "command_execution",
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          input: "/bin/zsh -lc 'gh pr create'",
          output: url,
          exitCode: 0,
        },
      });
      yield* engine.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
        Stream.filter(({ event }) => event.type === "thread.pull-request-synced"),
        Stream.runHead,
      );
      yield* reactor.drain;
      expect((yield* engine.getThreadShell(threadId))?.pullRequests).toMatchObject([
        { number: 42, source: "created", url },
      ]);
    }).pipe(Effect.provide(Reactor.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

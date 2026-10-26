import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import { terminalLaunchPolicy } from "@cogenly/provider-core/server/mcpSession";
import * as CliCredentials from "../accounts/CliCredentials.ts";
import { AccountError } from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { OrchestratorMcpFailure } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { worksInProjectFolder } from "../orchestration-v2/RuntimePolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as AgentProcesses from "../process/AgentProcesses.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertLiveCaller, loadCaller, unavailable } from "./threadAccess.ts";

const isAccountError = Schema.is(AccountError);
const isSandboxUnavailable = Schema.is(ReadOnlySandbox.SandboxUnavailable);

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
type Identity = { readonly terminalId: string };
type RunInput = {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly background?: boolean | undefined;
  readonly keepRunning?: boolean | undefined;
};

/** @effect-expect-leaking McpInvocationContext -- each HTTP request provides its authenticated caller. */
export class TerminalMcpService extends Context.Service<
  TerminalMcpService,
  {
    readonly run: (
      input: RunInput,
    ) => Effect.Effect<
      TerminalManager.AgentTerminalResult & { readonly sandbox?: "read-only" },
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
    readonly read: (
      input: Identity & { readonly sinceOffset?: number | undefined },
    ) => Effect.Effect<
      TerminalManager.AgentTerminalResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
    readonly write: (
      input: Identity & { readonly input: string },
    ) => Effect.Effect<{}, OrchestratorMcpFailure, McpInvocationContext.McpInvocationContext>;
    readonly kill: (
      input: Identity,
    ) => Effect.Effect<{}, OrchestratorMcpFailure, McpInvocationContext.McpInvocationContext>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<import("@cogenly/contracts").TerminalSummary>,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("cogenly-server/mcp/TerminalMcpService") {}

const make = Effect.gen(function* () {
  const agents = yield* AgentStore.AgentStore;
  const sandbox = yield* ReadOnlySandbox.ReadOnlySandbox;
  const manager = yield* TerminalManager.TerminalManager;
  const credentials = yield* CliCredentials.CliCredentials;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const files = yield* ProjectFiles.ProjectFiles;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const processes = yield* AgentProcesses.AgentProcesses;
  const access = Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const scope = yield* McpInvocationContext.requireThreadScope(invocation, "Terminal tools");
    // loadCaller is evaluated per call, never captured from a previous request.
    const caller = yield* loadCaller().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    return { scope, caller, threadId: scope.thread.threadId };
  });
  const writable = Effect.gen(function* () {
    const context = yield* access;
    yield* assertLiveCaller(context.caller);
    if (context.caller.caller?.surface === "builder")
      return yield* denied("Builder threads cannot run commands.");
    const thread = context.caller.caller!;
    const agent = yield* agents.forThread(thread.id).pipe(Effect.mapError(unavailable));
    const terminalPolicy = terminalLaunchPolicy({
      enabled: (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
        .enableAgentTerminals,
      ...context.caller.limits,
      builderMode: thread.surface === "builder",
      agentPermissions: agent?.permissions,
      chatMode: thread.surface === "chat",
      readOnlySandboxAvailable: sandbox.status.available,
    });
    if (
      terminalPolicy === null &&
      thread.surface === "chat" &&
      agent == null &&
      !sandbox.status.available
    )
      return yield* denied(
        new ReadOnlySandbox.SandboxUnavailable({ reason: sandbox.status.reason }).message,
      );
    if (terminalPolicy === null)
      return yield* denied(
        "Agent terminals require enabled tools, full-access/default mode and all sensitive agent grants.",
      );
    return { ...context, terminalPolicy };
  });
  return TerminalMcpService.of({
    run: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        const { started, sandboxed } = yield* executor.withLock(
          threadId,
          Effect.gen(function* () {
            const { caller, scope, terminalPolicy } = yield* writable;
            const thread = caller.caller!;
            if (thread.settledOverride === "settled" || thread.archivedAt !== null)
              return yield* denied("This thread is settled or archived.");
            const project = yield* projects
              .getById(thread.projectId)
              .pipe(Effect.mapError(unavailable));
            if (Option.isNone(project))
              return yield* denied("The thread workspace is unavailable.");
            // Chats have no worktree: a filed one looks things up from its
            // project folder, where its provider runs too.
            const folder = worksInProjectFolder(thread)
              ? yield* files.folderForThread(threadId).pipe(Effect.mapError(unavailable))
              : null;
            const root = yield* fs
              .realPath(folder?.dir ?? thread.worktreePath ?? project.value.workspaceRoot)
              .pipe(Effect.mapError(unavailable));
            const cwd = yield* fs
              .realPath(path.resolve(root, input.cwd ?? "."))
              .pipe(Effect.mapError(unavailable));
            // Canonicalize both paths to reject .. and symlink escapes. This is launch-context
            // validation, not a shell sandbox; full-access commands can still cd elsewhere.
            const relative = path.relative(root, cwd);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              return yield* denied("cwd must be inside this thread's workspace.");
            const started = yield* manager
              .runAgent({
                threadId,
                terminalPolicy,
                command: input.command,
                cwd,
                worktreePath: thread.worktreePath,
                providerInstanceId: scope.thread.providerInstanceId,
                background: true,
                // A foreground wait kills on timeout, so only a background command is kept.
                keepRunning: input.background === true && input.keepRunning === true,
                prepareCredentials: (terminalId) =>
                  credentials.launch(
                    { threadId, providerInstanceId: scope.thread.providerInstanceId },
                    terminalId,
                  ),
              })
              .pipe(
                Effect.mapError((cause) =>
                  isAccountError(cause) || isSandboxUnavailable(cause)
                    ? denied(cause.message)
                    : unavailable(),
                ),
              );
            return { started, sandboxed: terminalPolicy === "readOnlyLookup" };
          }),
        );
        const result = yield* input.background
          ? Effect.succeed(started)
          : manager
              .waitAgent({
                threadId,
                terminalId: started.terminalId,
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              })
              .pipe(Effect.mapError(unavailable));
        // Marks a chat's lookup that ran in the read-only sandbox, for the
        // agent and for the timeline row that shows it.
        return sandboxed ? { ...result, sandbox: "read-only" as const } : result;
      }),
    read: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        return yield* manager
          .readAgent({
            terminalId: input.terminalId,
            threadId,
            ...(input.sinceOffset === undefined ? {} : { sinceOffset: input.sinceOffset }),
          })
          .pipe(Effect.mapError(unavailable));
      }),
    write: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        return yield* executor.withLock(
          threadId,
          Effect.gen(function* () {
            yield* writable;
            yield* manager
              .readAgent({ threadId, terminalId: input.terminalId })
              .pipe(Effect.mapError(unavailable));
            yield* manager
              .write({ threadId, terminalId: input.terminalId, data: input.input })
              .pipe(Effect.mapError(unavailable));
            return {};
          }),
        );
      }),
    kill: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        const identity = { terminalId: input.terminalId, threadId };
        yield* manager.killAgent(identity).pipe(
          // A terminal evicted after it exited can still have children running.
          Effect.catch(() =>
            processes
              .terminate(identity)
              .pipe(
                Effect.flatMap((pids) =>
                  pids.length > 0 ? Effect.void : Effect.fail(unavailable()),
                ),
              ),
          ),
        );
        return {};
      }),
    list: () =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        return yield* manager.listAgents(threadId);
      }),
  });
});

export const layer = Layer.effect(TerminalMcpService, make);

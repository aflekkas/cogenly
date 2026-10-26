import * as CliCredentials from "../accounts/CliCredentials.ts";
import { AccountError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Vault from "../vault/Vault.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, loadCaller, unavailable } from "./threadAccess.ts";

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
type Identity = { readonly terminalId: string };
type RunInput = {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly background?: boolean | undefined;
};

/** @effect-expect-leaking McpInvocationContext -- each HTTP request provides its authenticated caller. */
export class TerminalMcpService extends Context.Service<
  TerminalMcpService,
  {
    readonly run: (
      input: RunInput,
    ) => Effect.Effect<
      TerminalManager.AgentTerminalResult,
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
      ReadonlyArray<import("@t3tools/contracts").TerminalSummary>,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("cogenly-server/mcp/TerminalMcpService") {}

const make = Effect.gen(function* () {
  const manager = yield* TerminalManager.TerminalManager;
  const credentials = yield* CliCredentials.CliCredentials;
  const vault = yield* Vault.Vault;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
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
    // These PTYs run on the host. Do not let an MCP call bypass a provider sandbox or approval.
    yield* assertFullAccess(
      context.caller,
      "Agent terminals require full-access mode with default interaction mode.",
    );
    if (!(yield* settings.getSettings.pipe(Effect.mapError(unavailable))).enableAgentTerminals)
      return yield* denied("Agent terminals are disabled in server settings.");
    return context;
  });
  return TerminalMcpService.of({
    run: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* access;
        const started = yield* executor.withLock(
          threadId,
          Effect.gen(function* () {
            const { caller, scope } = yield* writable;
            const thread = caller.caller!;
            if (thread.settledOverride === "settled" || thread.archivedAt !== null)
              return yield* denied("This thread is settled or archived.");
            const project = yield* projects
              .getById(thread.projectId)
              .pipe(Effect.mapError(unavailable));
            if (Option.isNone(project))
              return yield* denied("The thread workspace is unavailable.");
            const root = yield* fs
              .realPath(thread.worktreePath ?? project.value.workspaceRoot)
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
            return yield* manager
              .runAgent({
                threadId,
                command: input.command,
                cwd,
                worktreePath: thread.worktreePath,
                providerInstanceId: scope.thread.providerInstanceId,
                background: true,
                prepareCredentials: (terminalId) =>
                  credentials.launch(
                    { threadId, providerInstanceId: scope.thread.providerInstanceId },
                    terminalId,
                  ),
                // Vault values are redacted as output arrives, before it is stored or shown.
                redactOutput: yield* vault.outputRedactor,
              })
              .pipe(
                Effect.mapError((cause) =>
                  Schema.is(AccountError)(cause) ? denied(cause.message) : unavailable(),
                ),
              );
          }),
        );
        return yield* input.background
          ? Effect.succeed(started)
          : manager
              .waitAgent({
                threadId,
                terminalId: started.terminalId,
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              })
              .pipe(Effect.mapError(unavailable));
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
        yield* manager.killAgent({ ...input, threadId }).pipe(Effect.mapError(unavailable));
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

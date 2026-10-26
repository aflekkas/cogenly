import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
import { agentFixture } from "../agents/agent.testkit.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as CliCredentials from "../accounts/CliCredentials.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  defaultAgentPermissions,
  EnvironmentId,
  ProjectLabelId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TerminalMcpService from "./TerminalMcpService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Manager from "../terminal/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const caller = (id: string): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  requestNamespace: id,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId: ThreadId.make(id),
    providerSessionId: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

it.effect(
  "MCP callers cannot read, write, list or kill another thread's terminal; cwd escapes are refused",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-terminal-scope-" });
      const workspace = `${directory}/workspace`;
      yield* fs.makeDirectory(workspace);
      yield* fs.symlink(directory, `${workspace}/escape`);
      const projectFolder = `${directory}/Spawn Partners`;
      yield* fs.makeDirectory(projectFolder);
      const inputs: string[] = [];
      const signals: Array<string | undefined> = [];
      const spawnedIn: string[] = [];
      const launches: Array<{ shell: string; args?: string[]; env: NodeJS.ProcessEnv }> = [];
      let sandboxAvailable = true;
      const sandbox = ReadOnlySandbox.ReadOnlySandbox.of({
        setup: Effect.die("setup is not exercised here"),
        get status() {
          return sandboxAvailable
            ? { available: true as const, backend: "sandbox-exec" as const }
            : { available: false as const, reason: "sandbox probe failed" };
        },
        prepare: (input) =>
          Effect.succeed({
            shell: "/usr/bin/sandbox-exec",
            args: ["-p", "(deny default)", input.shell, ...input.args],
            env: { TMPDIR: "/terminal-private-temp" },
          }),
      });
      const manager = yield* Manager.makeWithOptions({
        logsDir: directory,
        processKillGraceMs: 0,
        processTable: Effect.succeed([]),
        resolveProviderInstanceEnvironment: () => Effect.succeed({}),
        ptyAdapter: {
          spawn: (input) =>
            Effect.sync(() => {
              spawnedIn.push(input.cwd);
              launches.push(input);
            }).pipe(
              Effect.as({
                pid: 12345,
                write: (data) => {
                  inputs.push(data);
                },
                resize: () => {},
                kill: (signal) => {
                  signals.push(signal);
                },
                onData: () => () => {},
                onExit: () => () => {},
              }),
            ),
        },
      }).pipe(Effect.provideService(ReadOnlySandbox.ReadOnlySandbox, sandbox));
      const project = {
        id: liveThreadShell(ThreadId.make("A")).projectId,
        title: "test",
        workspaceRoot: workspace,
        repositoryIdentity: null,
        faviconPath: null,
        projectIcon: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        deletedAt: null,
      };
      let agent = {
        ...agentFixture(),
        permissions: { ...defaultAgentPermissions },
      };
      const backgroundShells = new Map<ThreadId, OrchestrationV2ThreadShell>();
      const stoppedThreads = new Set<ThreadId>();
      const dependencies = Layer.mergeAll(
        Layer.succeed(ReadOnlySandbox.ReadOnlySandbox, sandbox),
        Layer.mock(AgentStore.AgentStore)({
          forThread: (id) => Effect.succeed(id === "persistent" ? agent : null),
        }),
        Layer.mock(CliCredentials.CliCredentials)({
          launch: () => Effect.succeed({ env: {}, complete: () => Effect.void }),
        }),
        Layer.succeed(Manager.TerminalManager, manager),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: (id, _fields, options) => {
            const shell = backgroundShells.get(id)!;
            expect(options?.turnItemTypes).toEqual(["run_interrupt_request"]);
            expect(options?.turnItemRunIds).toEqual([shell.latestRunId]);
            const projection = idleThreadProjection(shell);
            return Effect.succeed({
              ...projection,
              turnItems: stoppedThreads.has(id)
                ? [
                    {
                      id: TurnItemId.make("interrupt"),
                      threadId: id,
                      runId: shell.latestRunId,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 0,
                      status: "completed" as const,
                      title: "Interrupt requested",
                      startedAt: shell.updatedAt,
                      completedAt: shell.updatedAt,
                      updatedAt: shell.updatedAt,
                      type: "run_interrupt_request" as const,
                      message: "Stop",
                    },
                  ]
                : [],
            });
          },
          getThreadShell: (id) =>
            Effect.succeed(
              backgroundShells.get(id) ??
                (id === "builder"
                  ? { ...liveThreadShell(id), surface: "builder" as const }
                  : id === "chat"
                    ? { ...liveThreadShell(id), surface: "chat" as const }
                    : liveThreadShell(id, id === "plan" ? { interactionMode: "plan" } : {})),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(ProjectFiles.ProjectFiles)({
          folderForThread: (id) =>
            Effect.succeed(
              id === "chat"
                ? {
                    labelId: ProjectLabelId.make("label:spawn"),
                    name: "Spawn Partners",
                    dir: projectFolder,
                    instructions: "",
                    projectChatThreadId: null,
                  }
                : null,
            ),
        }),
        ThreadCommandExecutor.layer,
        ServerSettings.layerTest(),
      );
      yield* Effect.gen(function* () {
        const tools = yield* TerminalMcpService.TerminalMcpService;
        const as = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(Invocation.McpInvocationContext, caller(id)));
        for (const provider of ["claude", "codex"]) {
          const id = ThreadId.make(`background:${provider}`);
          const shell = {
            ...liveThreadShell(id, { activeRunId: null }),
            providerInstanceId: ProviderInstanceId.make(provider),
            latestRunId: RunId.make(`settled:${provider}`),
            pendingBackgroundTasks: [{ taskId: "native-child", kind: "subagent" as const }],
          };
          backgroundShells.set(id, shell);
          const asBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(Invocation.McpInvocationContext, {
                ...caller(id),
                thread: { ...caller(id).thread!, providerInstanceId: shell.providerInstanceId },
              }),
            );
          const terminal = yield* asBackground(tools.run({ command: "cat", background: true }));
          expect(yield* asBackground(tools.list())).toHaveLength(1);
          expect(yield* as("B", tools.list())).toEqual([]);
          yield* asBackground(tools.write({ terminalId: terminal.terminalId, input: "working" }));
          // Stop revokes immediately, even before the provider clears its roster.
          stoppedThreads.add(id);
          expect(
            (yield* asBackground(tools.run({ command: "cat", background: true })).pipe(Effect.flip))
              .code,
          ).toBe("parent_not_active");
          expect(
            (yield* asBackground(
              tools.write({ terminalId: terminal.terminalId, input: "late" }),
            ).pipe(Effect.flip)).code,
          ).toBe("parent_not_active");
          stoppedThreads.delete(id);
          backgroundShells.set(id, { ...shell, pendingBackgroundTasks: [] });
          expect(
            (yield* asBackground(tools.run({ command: "cat", background: true })).pipe(Effect.flip))
              .code,
          ).toBe("parent_not_active");
          // Cleanup still addresses the original thread after its work ended.
          yield* asBackground(tools.kill({ terminalId: terminal.terminalId }));
        }
        inputs.length = 0;
        signals.length = 0;
        spawnedIn.length = 0;
        launches.length = 0;
        for (const operation of [
          tools.run({ command: "echo forbidden", background: true }),
          tools.write({ terminalId: "builder-terminal", input: "echo forbidden\n" }),
        ]) {
          const error = yield* as("builder", operation).pipe(Effect.flip);
          expect(error.message).toContain("Builder threads cannot run commands");
        }
        for (const id of ["plan"]) {
          for (const operation of [
            tools.run({ command: "echo forbidden", background: true }),
            tools.write({ terminalId: "existing", input: "echo forbidden\n" }),
          ]) {
            const error = yield* as(id, operation).pipe(Effect.flip);
            expect(error.message).toContain("full-access/default");
          }
        }
        expect(spawnedIn).toEqual([]);
        expect(inputs).toEqual([]);
        const agentTerminal = yield* as(
          "persistent",
          tools.run({ command: "cat README", background: true }),
        );
        expect(agentTerminal.sandbox).toBe("read-only");
        expect(launches.at(-1)?.shell).toBe("/usr/bin/sandbox-exec");
        expect(launches.at(-1)?.args).toContain("cat README");
        agent = { ...agent, permissions: { ...agent.permissions, execute: false } };
        const revoked = yield* as(
          "persistent",
          tools.write({ terminalId: agentTerminal.terminalId, input: "blocked" }),
        ).pipe(Effect.flip);
        expect(revoked.message).toContain("read and execute grants");
        expect(inputs).toEqual([]);
        yield* as("persistent", tools.kill({ terminalId: agentTerminal.terminalId }));
        signals.length = 0;
        const started = yield* as("A", tools.run({ command: "cat", background: true }));
        expect(yield* as("B", tools.list())).toEqual([]);
        expect(yield* as("A", tools.list())).toHaveLength(1);
        for (const operation of [
          tools.read({ terminalId: started.terminalId }),
          tools.write({ terminalId: started.terminalId, input: "x" }),
          tools.kill({ terminalId: started.terminalId }),
        ]) {
          expect((yield* as("B", operation).pipe(Effect.flip))._tag).toBe("OrchestratorMcpFailure");
        }
        expect(inputs).toEqual([]);
        expect(signals).toEqual([]);
        for (const cwd of ["..", directory, "escape"]) {
          const error = yield* as("A", tools.run({ command: "echo nope", cwd })).pipe(Effect.flip);
          expect(error.message).toContain("cwd must be inside");
        }
        const permitted = yield* as(
          "restricted",
          tools.run({ command: "echo allowed", background: true }),
        );
        yield* as("restricted", tools.kill({ terminalId: permitted.terminalId }));
        yield* as("A", tools.kill({ terminalId: started.terminalId }));
        expect(signals).toContain("SIGKILL");
        // A filed chat looks things up from its project folder, not the
        // project's workspace, and cannot start outside it.
        const realFolder = yield* fs.realPath(projectFolder);
        spawnedIn.length = 0;
        const lookup = yield* as(
          "chat",
          tools.run({ command: "git log --oneline", background: true }),
        );
        // The result says it ran sandboxed; an ordinary thread's does not.
        expect(lookup.sandbox).toBe("read-only");
        expect(started.sandbox).toBeUndefined();
        expect(spawnedIn).toEqual([realFolder]);
        expect(launches.at(-1)?.shell).toBe("/usr/bin/sandbox-exec");
        expect(launches.at(-1)?.args).toContain("git log --oneline");
        expect(launches.at(-1)?.env.TMPDIR).toBe("/terminal-private-temp");
        expect(launches[0]?.shell).toBe("/usr/bin/sandbox-exec");
        const count = launches.length;
        sandboxAvailable = false;
        const refused = yield* as("chat", tools.run({ command: "ls" })).pipe(Effect.flip);
        expect(refused.message).toContain("Chat commands are unavailable on this machine");
        expect(launches).toHaveLength(count);
        yield* as("A", tools.run({ command: "pwd", background: true }));
        expect(launches.at(-1)?.shell).toBe("/bin/sh");
        sandboxAvailable = true;
        const escape = yield* as("chat", tools.run({ command: "ls", cwd: workspace })).pipe(
          Effect.flip,
        );
        expect(escape.message).toContain("cwd must be inside");
      }).pipe(Effect.provide(TerminalMcpService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

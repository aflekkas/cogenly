import * as CliCredentials from "../accounts/CliCredentials.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TerminalMcpService from "./TerminalMcpService.ts";
import * as Vault from "../vault/Vault.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Manager from "../terminal/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

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
      const inputs: string[] = [];
      const signals: Array<string | undefined> = [];
      const manager = yield* Manager.makeWithOptions({
        logsDir: directory,
        processKillGraceMs: 0,
        processTable: Effect.succeed([]),
        resolveProviderInstanceEnvironment: () => Effect.succeed({}),
        ptyAdapter: {
          spawn: () =>
            Effect.succeed({
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
        },
      });
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
      const dependencies = Layer.mergeAll(
        Layer.mock(CliCredentials.CliCredentials)({
          launch: () => Effect.succeed({ env: {}, complete: () => Effect.void }),
        }),
        Layer.mock(Vault.Vault)({ outputRedactor: Effect.succeed((chunk: string) => chunk) }),
        Layer.succeed(Manager.TerminalManager, manager),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              liveThreadShell(id, id === "restricted" ? { runtimeMode: "full-access" } : {}),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        ThreadCommandExecutor.layer,
        ServerSettings.layerTest(),
      );
      yield* Effect.gen(function* () {
        const tools = yield* TerminalMcpService.TerminalMcpService;
        const as = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(Invocation.McpInvocationContext, caller(id)));
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
      }).pipe(Effect.provide(TerminalMcpService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

import { expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  SecretRef,
  ThreadId,
  VaultError,
  VaultItemId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Orchestrator from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Settings from "../serverSettings.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Vault from "../vault/Vault.ts";
import * as Accounts from "../accounts/AccountConnections.ts";
import * as Machines from "../machines/Machines.ts";

it.effect("a failed saveToVault leaves the private answer available for retry", () => {
  let available = true,
    failSave = true;
  const threadId = ThreadId.make("private-answer");
  const projection = idleThreadProjection(liveThreadShell(threadId));
  const records = {
    ...projection,
    runs: [
      {
        id: RunId.make("run"),
        status: "running",
        rootNodeId: NodeId.make("node"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      } as never,
    ],
  };
  const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(records),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "secret_request.record")
            records.turnItems = [
              { type: "secret_request", id: command.turnItemId, secretStatus: "saved" },
            ] as never;
          return records;
        }) as never,
    }),
    Layer.mock(Launch.ThreadLaunchService)({}),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({}),
    Layer.mock(Providers.ProviderRegistry)({}),
    Layer.mock(Schedules.ScheduledTaskService)({}),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed({} as never) }),
    Layer.mock(Accounts.AccountConnections)({ bindSecretRequest: () => Effect.void }),
    Layer.mock(Secrets.SecretRequests)({
      savedRef: () => Effect.succeed(available ? Option.some(ref) : Option.none()),
      consume: () =>
        Effect.sync(() => {
          available = false;
          return "private-value";
        }),
      adopt: (_input, save) =>
        save("private-value").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              available = false;
            }),
          ),
        ),
    }),
    Layer.mock(Vault.Vault)({
      list: () => Effect.succeed({ items: [] }),
      saveSecretValue: () =>
        failSave
          ? Effect.fail(new VaultError({ reason: "storage" }))
          : Effect.succeed({ item: { id: VaultItemId.make("saved"), name: "saved" } as never }),
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Orchestrator.OrchestratorMcpService;
    const scope = {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session",
      },
    };
    const input = {
      clientRequestId: "save",
      label: "Key",
      reason: "Sign in",
      saveToVault: { name: "saved", type: "api_key" as const },
    };
    expect((yield* service.requestSecret(scope, input).pipe(Effect.result))._tag).toBe("Failure");
    expect(available).toBe(true);
    failSave = false;
    expect(yield* service.requestSecret(scope, input)).toMatchObject({
      status: "saved",
      vaultItemId: "saved",
    });
    expect(available).toBe(false);
  }).pipe(Effect.provide(Orchestrator.layer.pipe(Layer.provide(dependencies))));
});

it.effect("remote delegation retries without clientRequestId reuse their command identity", () => {
  const threadId = ThreadId.make("remote-retry");
  const projection = idleThreadProjection(liveThreadShell(threadId));
  const records = {
    ...projection,
    runs: [
      {
        id: RunId.make("run:retry"),
        status: "running",
        rootNodeId: NodeId.make("root"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      } as never,
    ],
  };
  const keys: string[] = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(records),
      hasReceipt: (id) =>
        Effect.sync(() => {
          keys.push(id);
          return true;
        }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({}),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({}),
    Layer.mock(Providers.ProviderRegistry)({}),
    Layer.mock(Schedules.ScheduledTaskService)({}),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed({} as never) }),
    Layer.mock(Accounts.AccountConnections)({}),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.mock(Vault.Vault)({}),
    Layer.mock(Machines.Machines)({
      list: Effect.succeed({
        machines: [
          {
            environmentId: EnvironmentId.make("target"),
            name: "Target",
            kind: "other-computer",
            hardware: "laptop",
            platform: "darwin",
            providers: [],
            relation: "spoke",
            online: true,
            lastSeenAt: null,
            pairedAt: null,
            pairing: "paired",
          },
        ],
        link: { _tag: "hub", spokes: 1 },
      }),
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Orchestrator.OrchestratorMcpService;
    const scope = {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session",
      },
    };
    // An accepted receipt takes the retry path; reading the missing task stops this fixture.
    for (let i = 0; i < 2; i++)
      yield* service
        .delegateTask(scope, { machine: "Target", task: "Audit the code", mode: "async" })
        .pipe(Effect.result);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  }).pipe(Effect.provide(Orchestrator.layer.pipe(Layer.provideMerge(dependencies))));
});

import { expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import {
  EnvironmentId,
  NodeId,
  type OrchestratorMcpDelegateTaskInput,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SecretRef,
  type ServerProvider,
  ThreadId,
  ThreadRemoteError,
  VaultError,
  VaultItemId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { TestClock } from "effect/testing";
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
import * as RemoteLaunch from "../orchestration-v2/RemoteThreadLaunch.ts";

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
      list: () => Effect.succeed({ items: [], sites: [] }),
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

const serverProvider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-23T11:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const pairedMachine = (id: string, name: string) => ({
  environmentId: EnvironmentId.make(id),
  name,
  kind: "cloud-server" as const,
  hardware: "server" as const,
  platform: "linux" as const,
  providers: [],
  relation: "hub" as const,
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: "paired" as const,
});

/**
 * A thread running on this machine's `claude-personal`, paired with a cloud
 * server whose own instances are named differently.
 */
const crossMachineFixture = (
  remote: (machine: EnvironmentId) => ReadonlyArray<ServerProvider>,
  background = false,
) => {
  const threadId = ThreadId.make("cross-machine");
  const instanceId = ProviderInstanceId.make("claude-personal");
  const shell = liveThreadShell(threadId);
  const projection = idleThreadProjection({
    ...shell,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-4-5" },
  });
  const records = {
    ...projection,
    runs: [
      {
        id: RunId.make("run:cross"),
        status: background ? "completed" : "running",
        rootNodeId: NodeId.make("root"),
        providerInstanceId: instanceId,
      } as never,
    ],
  };
  if (background)
    records.providerThreads = [
      { id: "provider-thread", pendingBackgroundTasks: [{ taskId: "native", kind: "subagent" }] },
    ] as never;
  const dispatched: Array<unknown> = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(records),
      hasReceipt: () => Effect.succeed(false),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 0, storedEvents: [] };
        }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({}),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([instanceId, ProviderInstanceId.make("codex")]),
    }),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed([
        serverProvider("claude-personal", "claude", ["claude-opus-4-5"]),
        serverProvider("codex", "codex", ["gpt-5"]),
      ]),
    }),
    Layer.mock(Schedules.ScheduledTaskService)({}),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed({ modelEffortDefaults: {} } as never),
    }),
    Layer.mock(Accounts.AccountConnections)({}),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.mock(Vault.Vault)({}),
    Layer.mock(Machines.Machines)({
      list: Effect.succeed({
        machines: [pairedMachine("cloud", "Cloud server"), pairedMachine("old", "Old server")],
        link: { _tag: "spoke", hubEnvironmentId: EnvironmentId.make("cloud") } as never,
      }),
    }),
    Layer.mock(RemoteLaunch.RemoteThreadLaunch)({
      catalog: (machine) =>
        machine === "old"
          ? Effect.fail(
              new ThreadRemoteError({ reason: "offline", detail: "Old server did not answer." }),
            )
          : Effect.succeed(Option.some(remote(machine))),
    }),
  );
  const scope = {
    environmentId: EnvironmentId.make("test"),
    requestNamespace: "test",
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
    client: undefined,
    thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session" },
  };
  const selections = () =>
    dispatched.map((command) => (command as { modelSelection: unknown }).modelSelection);
  return {
    scope,
    selections,
    provide: <A, E>(effect: Effect.Effect<A, E, Orchestrator.OrchestratorMcpService>) =>
      effect.pipe(Effect.provide(Orchestrator.layer.pipe(Layer.provideMerge(dependencies)))),
  };
};

it.effect("delegating to another machine picks its instance of the requested driver", () => {
  const fixture = crossMachineFixture(() => [
    serverProvider("claude", "claude", ["claude-sonnet-4-5", "claude-opus-4-5"]),
    serverProvider("codex", "codex", ["gpt-6.1-sol"]),
  ]);
  return fixture.provide(
    Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      const delegate = (input: Partial<OrchestratorMcpDelegateTaskInput>) =>
        service
          .delegateTask(fixture.scope, {
            machine: "Cloud server",
            task: "Audit the code",
            mode: "async",
            ...input,
          })
          .pipe(Effect.exit);
      // Named here, absent there: the same driver there, its first model.
      yield* delegate({
        clientRequestId: "named",
        target: { providerInstanceId: ProviderInstanceId.make("claude-personal") },
      });
      // Inherited: the parent's model, which that instance also offers.
      yield* delegate({ clientRequestId: "inherited" });
      // An instance that exists there resolves as named.
      yield* delegate({
        clientRequestId: "exact",
        target: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      });
      expect(fixture.selections()).toEqual([
        { instanceId: "claude", model: "claude-sonnet-4-5" },
        { instanceId: "claude", model: "claude-opus-4-5" },
        { instanceId: "codex", model: "gpt-6.1-sol" },
      ]);
    }),
  );
});

it.effect("delegating to another machine without that driver lists what it has", () => {
  const fixture = crossMachineFixture(() => [serverProvider("codex", "codex", ["gpt-6.1-sol"])]);
  return fixture.provide(
    Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      const refused = yield* service
        .delegateTask(fixture.scope, {
          machine: "Cloud server",
          task: "Audit the code",
          mode: "async",
          target: { providerInstanceId: ProviderInstanceId.make("claude-personal") },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        code: "provider_unavailable",
        message:
          "Cloud server has no provider instance claude-personal or other claude instance that can run a child task. Available there: codex (codex). See orchestrator_capabilities.",
      });
      expect(fixture.selections()).toEqual([]);
    }),
  );
});

it.effect("capabilities list each paired machine's providers compactly", () => {
  const fixture = crossMachineFixture(() => [serverProvider("codex", "codex", ["gpt-6.1-sol"])]);
  return fixture.provide(
    Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      const { machines } = yield* service.capabilities(fixture.scope);
      expect(
        machines?.map(({ name, catalog, catalogError }) => ({ name, catalog, catalogError })),
      ).toEqual([
        {
          name: "Cloud server",
          catalog: [
            {
              providerInstanceId: "codex",
              driverKind: "codex",
              displayName: null,
              models: ["gpt-6.1-sol"],
              canRunChildTask: true,
            },
          ],
          catalogError: undefined,
        },
        { name: "Old server", catalog: undefined, catalogError: "Old server did not answer." },
      ]);
    }),
  );
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

const loginFixture = (
  answer: (login: Record<string, unknown>) => Record<string, unknown>,
  onPending = () => {},
) => {
  const threadId = ThreadId.make("login-request");
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
  const recorded: Array<{ secretStatus: string; login?: Record<string, unknown> }> = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(records),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "secret_request.record") {
            recorded.push(command as never);
            onPending();
            // The user answers as soon as the card appears.
            if (command.secretStatus === "pending")
              records.turnItems = [
                {
                  type: "secret_request",
                  id: command.turnItemId,
                  ...answer(command.login as never),
                },
              ] as never;
          }
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
    Layer.mock(Accounts.AccountConnections)({}),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.mock(Vault.Vault)({
      findLogin: (input) =>
        Effect.succeed(
          input.itemId === "vault:old"
            ? {
                status: "found" as const,
                item: { id: VaultItemId.make("vault:old"), name: "GitHub", type: "login" } as never,
              }
            : { status: "not_found" as const },
        ),
    }),
  );
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
  return {
    scope,
    recorded,
    provide: <A, E>(effect: Effect.Effect<A, E, Orchestrator.OrchestratorMcpService>) =>
      effect.pipe(Effect.provide(Orchestrator.layer.pipe(Layer.provide(dependencies)))),
  };
};

it.effect("request_login records a sign-in card and returns the saved vault item", () => {
  const fixture = loginFixture((login) => ({
    secretStatus: "saved",
    login: { ...login, savedItemId: "vault:new", savedItemName: "GitHub", kept: true },
  }));
  return fixture.provide(
    Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      const result = yield* service.requestLogin(fixture.scope, {
        site: "https://github.com/login?return_to=/settings",
        siteName: "GitHub",
        reason: "Open the repository settings.",
        usernameHint: " ada ",
      });
      expect(result).toEqual({
        status: "saved",
        vaultItemId: "vault:new",
        vaultItemName: "GitHub",
        domain: "github.com",
        updated: false,
        kept: true,
      });
      expect(fixture.recorded[0]).toMatchObject({
        secretStatus: "pending",
        label: "Sign in to GitHub",
        login: {
          origin: "https://github.com",
          siteName: "GitHub",
          usernameHint: "ada",
          fields: ["username", "password"],
        },
      });
    }),
  );
});

it.effect("request_login reports a declined card and can update an existing login", () => {
  const declined = loginFixture(() => ({ secretStatus: "declined" }));
  const updated = loginFixture((login) => ({
    secretStatus: "saved",
    login: { ...login, savedItemId: "vault:old", savedItemName: "GitHub", kept: true },
  }));
  return Effect.gen(function* () {
    const ask = (input: { readonly updateItemId?: string; readonly clientRequestId?: string }) =>
      Effect.gen(function* () {
        const service = yield* Orchestrator.OrchestratorMcpService;
        return yield* service.requestLogin(declined.scope, {
          site: "github.com",
          reason: "Sign in again.",
          ...input,
        });
      });
    expect(yield* declined.provide(ask({}))).toEqual({ status: "declined" });
    expect(yield* updated.provide(ask({ updateItemId: "vault:old" }))).toMatchObject({
      status: "saved",
      vaultItemId: "vault:old",
      updated: true,
    });
    expect(updated.recorded[0]?.login).toMatchObject({
      updateItemId: "vault:old",
      updateItemName: "GitHub",
    });
    const missing = yield* updated
      .provide(ask({ updateItemId: "vault:missing", clientRequestId: "other" }))
      .pipe(Effect.flip);
    expect(missing).toMatchObject({ code: "invalid_request" });
  });
});

it.effect("a native background caller can delegate after its parent settles", () => {
  const fixture = crossMachineFixture(
    () => [serverProvider("claude", "claude", ["claude-opus-4-5"])],
    true,
  );
  return fixture.provide(
    Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      yield* service
        .delegateTask(fixture.scope, {
          machine: "Cloud server",
          task: "Continue background work",
          mode: "async",
          target: { driverKind: ProviderDriverKind.make("claude") },
        })
        .pipe(Effect.exit);
      expect(fixture.selections()).toHaveLength(1);
    }),
  );
});

it.effect("a bounded login wait leaves its card answerable for a late answer", () =>
  Effect.gen(function* () {
    const appeared = yield* Deferred.make<void>();
    const fixture = loginFixture(
      () => ({ secretStatus: "pending" }),
      () => Deferred.doneUnsafe(appeared, Effect.void),
    );
    const request = fixture.provide(
      Effect.gen(function* () {
        const service = yield* Orchestrator.OrchestratorMcpService;
        return yield* service.requestLogin(fixture.scope, {
          site: "example.test",
          reason: "Sign in",
          timeoutMs: 1000,
        });
      }),
    );
    const fiber = yield* request.pipe(Effect.forkChild);
    yield* Deferred.await(appeared);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toEqual({ status: "timed_out" });
    expect(fixture.recorded.some((card) => card.secretStatus === "cancelled")).toBe(false);
  }),
);

it.effect(
  "thread list and read include all visible PR links and retain the legacy singular link",
  () => {
    const threadId = ThreadId.make("thread:all-prs");
    const base = liveThreadShell(threadId);
    const shell = {
      ...base,
      linkedPullRequest: {
        projectId: base.projectId,
        repository: "acme/app",
        number: 41,
        url: "https://github.com/acme/app/pull/41",
      },
      pullRequests: [41, 42, 43].map((number) => ({
        host: "github.com",
        repository: "acme/app",
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        source: number === 43 ? ("stack-dismissed" as const) : ("agent" as const),
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      })),
    };
    const projection = idleThreadProjection(shell);
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(projection),
        getProjectThreadRecords: () => Effect.succeed(projection),
        getThreadShell: () => Effect.succeed(shell),
        listProjectThreads: () => Effect.succeed([shell]),
        getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
      }),
      Layer.mock(Launch.ThreadLaunchService)({}),
      Layer.mock(Adapters.ProviderAdapterRegistryV2)({}),
      Layer.mock(Providers.ProviderRegistry)({}),
      Layer.mock(Schedules.ScheduledTaskService)({}),
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(Git.GitVcsDriver)({}),
      Settings.layerTest(),
      Layer.mock(Accounts.AccountConnections)({}),
      Layer.mock(Secrets.SecretRequests)({}),
      Layer.mock(Vault.Vault)({}),
    );
    return Effect.gen(function* () {
      const service = yield* Orchestrator.OrchestratorMcpService;
      const scope = {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
        client: undefined,
        thread: undefined,
      };
      const listed = yield* service.listThreads(scope, { projectId: shell.projectId });
      const read = yield* service.readThread(scope, { threadId });
      for (const thread of [listed.threads[0]!, read.thread]) {
        expect(thread.linkedPullRequest).toEqual(shell.linkedPullRequest);
        expect(thread.pullRequests).toMatchObject([
          { number: 41, state: null },
          { number: 42, state: null },
        ]);
        expect(thread.pullRequests).toHaveLength(2);
      }
    }).pipe(Effect.provide(Orchestrator.layer.pipe(Layer.provide(dependencies))));
  },
);

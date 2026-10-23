import * as AccountsMcp from "../mcp/AccountsMcpService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { SecretRef } from "@t3tools/contracts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Connections from "./AccountConnections.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as PlatformError from "effect/PlatformError";
import * as Workspace from "../agents/AgentWorkspaceService.ts";
import * as AgentService from "../agents/AgentService.ts";
import * as WorkHandoff from "../work/WorkHandoffService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Deferred from "effect/Deferred";
import {
  AccountId,
  AgentId,
  EnvironmentId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  defaultAgentPermissions,
  type Agent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import * as Manager from "../terminal/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Accounts from "./Accounts.ts";
import * as Access from "./AccountAccess.ts";
import * as Cli from "./CliCredentials.ts";

const project = ProjectLabelId.make("project:one");
const instance = ProviderInstanceId.make("codex");
const auth = (id = "owner") => ({ threadId: ThreadId.make(id), providerInstanceId: instance });
const token = "synthetic-token-for-cli-tests";
const agent: Agent = {
  id: AgentId.make("agent:test"),
  name: "Test",
  avatar: { seed: "test" },
  instructions: "",
  modelSelection: { instanceId: instance, model: "test" },
  fallbackChain: [],
  runtimeMode: "full-access",
  projectId: null,
  dailyRunCap: 100,
  responsibility: "",
  permissions: defaultAgentPermissions,
  notifyPolicy: "all",
  conversationThreadId: ThreadId.make("agent"),
  projectFolderId: project,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  consecutiveFailures: 0,
  backoffUntil: null,
  fallbackIndex: 0,
  fallbackReason: null,
  fallbackUntil: null,
};
const fixture = Effect.gen(function* () {
  const secretValues = new Map<string, Uint8Array>();
  const shells = new Map<string, OrchestrationV2ThreadShell>();
  const scopes = new Map<string, ProjectLabelId | null>();
  const agentThreads = new Set<string>();
  const processInputs: Array<ProcessRunner.ProcessRunInput> = [];
  let processOutput: ProcessRunner.ProcessRunOutput = {
    stdout: "authenticated",
    stderr: "",
    code: 0 as ProcessRunner.ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
  let missing = false;
  const dependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    NodeCrypto.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.succeed(Option.fromNullishOr(secretValues.get(name))),
      remove: (name) =>
        Effect.sync(() => {
          secretValues.delete(name);
        }),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      create: (name, value) =>
        Effect.sync(() => {
          secretValues.set(name, value);
        }),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("machine:test")),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? liveThreadShell(id)),
    }),
    Layer.mock(ProjectFiles.ProjectFiles)({
      folderForThread: (id) =>
        Effect.succeed(
          scopes.get(id) === null
            ? null
            : {
                labelId: scopes.get(id) ?? project,
                name: "Test",
                dir: "/test",
                instructions: "",
                projectChatThreadId: null,
              },
        ),
    }),
    Layer.mock(AgentStore.AgentStore)({
      forThread: (id) => Effect.succeed(agentThreads.has(id) ? agent : null),
    }),
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) => {
        processInputs.push(input);
        return missing
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: input.command,
                argumentCount: input.args.length,
                cause: PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            )
          : Effect.succeed(processOutput);
      },
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const vaultLayer = Vault.layer.pipe(Layer.provideMerge(dependencies));
  const accountsLayer = Accounts.layer.pipe(Layer.provideMerge(vaultLayer));
  const accessLayer = Access.layer.pipe(Layer.provideMerge(accountsLayer));
  const layer = Cli.layer.pipe(Layer.provideMerge(accessLayer));
  return {
    layer,
    shells,
    scopes,
    agentThreads,
    processInputs,
    setOutput: (value: Partial<ProcessRunner.ProcessRunOutput>) => {
      processOutput = { ...processOutput, ...value };
    },
    setMissing: () => {
      missing = true;
    },
  };
});
const create = (serviceId = "cloudflare", value = token) =>
  Effect.gen(function* () {
    const vault = yield* Vault.Vault;
    const accounts = yield* Accounts.Accounts;
    const { item } = yield* vault.create({
      name: `${serviceId}:synthetic`,
      type: "api_key",
      scopeProjectId: project,
      secretFields: {
        value,
        ...(serviceId === "cloudflare" ? { username: "synthetic-cloudflare-account" } : {}),
      },
    });
    const { account } = yield* accounts.create({
      serviceId,
      displayLabel: "Work",
      scopeProjectId: project,
      credentials: [
        {
          kind: "token",
          vaultItemId: item.id,
          portability: "shared",
          deliveryBindings: ["cli"],
          policy: { processExposure: "ask" },
        },
      ],
    });
    return { account, credential: account.credentials[0]!, item };
  });
const attach = (created: Effect.Success<ReturnType<typeof create>>, id = "owner") =>
  Effect.gen(function* () {
    const access = yield* Access.AccountAccess;
    const result = yield* access.setThreadBinding(auth(id), {
      accountId: created.account.id,
      credentialId: created.credential.id,
      attached: true,
    });
    expect(result.status).toBe("approval_required");
    if (!result.approvalId) return yield* Effect.die("missing approval");
    yield* access.approve(result.approvalId, "thread");
  });

describe("portable CLI process credentials", () => {
  it.effect(
    "injects only approved attached credentials after provider overrides; audits, redacts and never persists tokens in args/events",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const created = yield* create();
          yield* create("github", "unrelated-synthetic-github-token");
          const access = yield* Access.AccountAccess;
          const cli = yield* Cli.CliCredentials;
          const vault = yield* Vault.Vault;
          const result = yield* access.setThreadBinding(auth(), {
            accountId: created.account.id,
            credentialId: created.credential.id,
            attached: true,
          });
          expect(result).toMatchObject({ status: "approval_required" });
          expect(yield* cli.launch(auth(), "denied-terminal").pipe(Effect.flip)).toMatchObject({
            reason: "approval_required",
          });
          const sql = yield* SqlClient.SqlClient;
          const approvals = yield* sql<{
            action_json: string;
            agent_id: string | null;
          }>`SELECT action_json, agent_id FROM agent_approvals WHERE id = ${result.approvalId!}`;
          expect(approvals[0]?.agent_id).toBeNull();
          expect(approvals[0]?.action_json).toContain(
            "The agent and the commands it runs can read this token.",
          );
          yield* access.approve(result.approvalId!, "thread");
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "accounts-cli-test-" });
          const spawns: Array<{ env: NodeJS.ProcessEnv; args?: string[] }> = [];
          const events: unknown[] = [];
          const outputSeen = yield* Deferred.make<void>();
          const manager = yield* Manager.makeWithOptions({
            logsDir: directory,
            processKillGraceMs: 0,
            processTable: Effect.succeed([]),
            env: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "ambient" },
            resolveProviderInstanceEnvironment: () =>
              Effect.succeed({ CLOUDFLARE_API_TOKEN: "provider" }),
            ptyAdapter: {
              spawn: (input) => {
                spawns.push(input);
                return Effect.succeed({
                  pid: 12345,
                  write: () => {},
                  resize: () => {},
                  kill: () => {},
                  onData: (listener) => {
                    listener(token.slice(0, 12));
                    listener(token.slice(12) + " finished");
                    return () => {};
                  },
                  onExit: () => () => {},
                });
              },
            },
          });
          yield* manager.subscribe((event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "output" && event.data.includes("finished")
                  ? Deferred.succeed(outputSeen, undefined)
                  : Effect.void,
              ),
            ),
          );
          const terminal = yield* manager.runAgent({
            threadId: "owner",
            command: "wrangler whoami",
            cwd: directory,
            providerInstanceId: instance,
            background: true,
            prepareCredentials: (id) => cli.launch(auth(), id),
          });
          yield* Deferred.await(outputSeen);
          expect(
            (yield* manager.readAgent({ threadId: "owner", terminalId: terminal.terminalId }))
              .output,
          ).not.toContain(token);
          expect(spawns).toHaveLength(1);
          expect(spawns[0]?.env.CLOUDFLARE_API_TOKEN).toBe(token);
          expect(spawns[0]?.env.CLOUDFLARE_ACCOUNT_ID).toBe("synthetic-cloudflare-account");
          expect(spawns[0]?.env.GH_TOKEN).toBeUndefined();
          expect(JSON.stringify(spawns[0]?.args)).not.toContain(token);
          expect(JSON.stringify(events)).not.toContain(token);
          expect(JSON.stringify(yield* sql`SELECT action_json FROM agent_approvals`)).not.toContain(
            token,
          );
          const usage = (yield* vault.listUsage({ itemId: created.item.id })).usage;
          expect(usage.find((u) => u.outcome === "delivered")).toMatchObject({
            credentialId: created.credential.id,
            credentialRevision: "1",
            projectId: project,
            environmentId: "machine:test",
            threadId: "owner",
            agentId: null,
            terminalId: terminal.terminalId,
            deliveryMethod: "environment",
            providerInstanceId: instance,
          });
          expect(usage.some((u) => u.outcome === "approval_required")).toBe(true);
          yield* vault.update({
            id: created.item.id,
            secretFields: { value: "replacement-synthetic-token" },
          });
          const scrubbed = yield* vault.scrubText(
            `${token} ${Buffer.from(token).toString("base64")} replacement-synthetic-token`,
          );
          expect(scrubbed).not.toContain(token);
          expect(scrubbed).not.toContain(Buffer.from(token).toString("base64"));
          expect(scrubbed).not.toContain("replacement-synthetic-token");
          expect(yield* cli.launch(auth(), "replacement").pipe(Effect.flip)).toMatchObject({
            reason: "approval_required",
          });
          yield* vault.delete({ id: created.item.id });
          expect(yield* vault.scrubText(token)).not.toContain(token);
          yield* manager.killAgent({ threadId: "owner", terminalId: terminal.terminalId });
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("audits failed process launches without publishing credentials", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const created = yield* create("github");
        yield* attach(created);
        const cli = yield* Cli.CliCredentials;
        const vault = yield* Vault.Vault;
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "account-spawn-failure-",
        });
        const manager = yield* Manager.makeWithOptions({
          logsDir: directory,
          processTable: Effect.succeed([]),
          processKillGraceMs: 0,
          ptyAdapter: {
            spawn: () =>
              Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "synthetic failure" })),
          },
        });
        const result = yield* manager.runAgent({
          threadId: "owner",
          cwd: directory,
          command: "gh auth status",
          background: true,
          prepareCredentials: (id) => cli.launch(auth(), id),
        });
        expect(result.status).toBe("error");
        const usage = (yield* vault.listUsage({ itemId: created.item.id })).usage;
        expect(
          usage.some((u) => u.outcome === "launch_failed" && u.terminalId === result.terminalId),
        ).toBe(true);
        expect(usage.some((u) => u.outcome === "delivered")).toBe(false);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "enforces denial, expiry, revocation, detachment, project filtering and provider ownership",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const created = yield* create("github");
          const access = yield* Access.AccountAccess;
          const cli = yield* Cli.CliCredentials;
          const accounts = yield* Accounts.Accounts;
          yield* attach(created);
          f.scopes.set("outsider", ProjectLabelId.make("project:other"));
          expect(
            yield* access
              .setThreadBinding(auth("outsider"), {
                accountId: created.account.id,
                credentialId: created.credential.id,
                attached: true,
              })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
          expect(
            yield* cli
              .launch(
                { ...auth(), providerInstanceId: ProviderInstanceId.make("wrong") },
                "wrong-provider",
              )
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "denied" });
          yield* accounts.update({
            id: created.account.id,
            scopeProjectId: project,
            credentials: [{ ...created.credential, policy: { processExposure: "deny" } }],
          });
          expect(yield* cli.launch(auth(), "policy-denied").pipe(Effect.flip)).toMatchObject({
            reason: "denied",
          });
          yield* accounts.update({
            id: created.account.id,
            scopeProjectId: project,
            credentials: [{ ...created.credential, expiresAt: "1970-01-01T00:00:00.000Z" }],
          });
          expect(yield* cli.launch(auth(), "expired").pipe(Effect.flip)).toMatchObject({
            reason: "expired",
          });
          yield* accounts.update({
            id: created.account.id,
            scopeProjectId: project,
            credentials: [created.credential],
          });
          const removed = yield* access.removeAccess({
            scopeProjectId: project,
            id: created.account.id,
            credentialId: created.credential.id,
          });
          expect(removed.affectedThreadIds).toEqual(["owner"]);
          expect((yield* cli.launch(auth(), "after-remove")).env).toEqual({});
          const pending = yield* access.setThreadBinding(auth(), {
            accountId: created.account.id,
            credentialId: created.credential.id,
            attached: true,
          });
          yield* access.setThreadBinding(auth(), {
            accountId: created.account.id,
            credentialId: created.credential.id,
            attached: false,
          });
          expect(
            yield* access.approve(pending.approvalId!, "thread").pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
          expect((yield* cli.launch(auth(), "detached")).env).toEqual({});
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses explicit agent/project grants on scheduled runs and intersects every child with its ancestors",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.agentThreads.add("agent");
        f.agentThreads.add("scheduled");
        f.agentThreads.add("foreign-project");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES (${agent.id}, 'agent', '{}', 1)`;
          const created = yield* create("github");
          const access = yield* Access.AccountAccess;
          const cli = yield* Cli.CliCredentials;
          const binding = {
            accountId: created.account.id,
            credentialId: created.credential.id,
            attached: true,
          };
          const request = yield* access.setThreadBinding(auth("agent"), binding);
          yield* access.approve(request.approvalId!, "agent_project");
          expect(yield* access.setThreadBinding(auth("scheduled"), binding)).toMatchObject({
            status: "attached",
          });
          expect((yield* cli.launch(auth("scheduled"), "scheduled")).env.GH_TOKEN).toBe(token);
          f.shells.set("child", {
            ...liveThreadShell(ThreadId.make("child")),
            lineage: {
              parentThreadId: ThreadId.make("agent"),
              rootThreadId: ThreadId.make("agent"),
              relationshipToParent: "subagent",
            },
          });
          const child = yield* access.setThreadBinding(auth("child"), binding);
          yield* access.approve(child.approvalId!, "thread");
          expect((yield* cli.launch(auth("child"), "child")).env.GH_TOKEN).toBe(token);
          const unrelated = yield* create("cloudflare", "unrelated-child-token");
          expect(
            yield* access.setThreadBinding(auth("child"), {
              accountId: unrelated.account.id,
              credentialId: unrelated.credential.id,
              attached: true,
            }),
          ).toMatchObject({ status: "denied" });
          yield* access.setThreadBinding(auth("agent"), { ...binding, attached: false });
          expect(yield* cli.launch(auth("child"), "revoked-child").pipe(Effect.flip)).toMatchObject(
            { reason: "denied" },
          );
          f.scopes.set("foreign-project", ProjectLabelId.make("project:foreign"));
          expect(
            yield* access.setThreadBinding(auth("foreign-project"), binding).pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not turn broadly stored tokens into cross-project process grants", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const id of ["agent:one", "agent:two", "agent:scheduled"]) f.agentThreads.add(id);
      f.scopes.set("agent:two", ProjectLabelId.make("project:two"));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES (${agent.id}, 'agent', '{}', 1)`;
        const vault = yield* Vault.Vault;
        const accounts = yield* Accounts.Accounts;
        const access = yield* Access.AccountAccess;
        const { item } = yield* vault.create({
          name: "shared-token",
          type: "api_key",
          scopeProjectId: null,
          secretFields: { value: token },
        });
        const { account } = yield* accounts.create({
          serviceId: "github",
          displayLabel: "Shared",
          scopeProjectId: null,
          credentials: [
            {
              kind: "token",
              vaultItemId: item.id,
              portability: "shared",
              deliveryBindings: ["cli"],
              policy: { processExposure: "ask" },
            },
          ],
        });
        const binding = {
          accountId: account.id,
          credentialId: account.credentials[0]!.id,
          attached: true,
        };
        const request = yield* access.setThreadBinding(auth("agent:one"), binding);
        yield* access.approve(request.approvalId!, "agent_project");
        expect((yield* access.setThreadBinding(auth("agent:scheduled"), binding)).status).toBe(
          "attached",
        );
        expect((yield* access.setThreadBinding(auth("agent:two"), binding)).status).toBe(
          "approval_required",
        );
        expect(
          yield* (yield* Cli.CliCredentials)
            .launch(auth("agent:two"), "other-project")
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "approval_required" });
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("routes owner-thread consent and rejection through existing agent approvals", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const created = yield* create("github");
        const access = yield* Access.AccountAccess;
        const workspace = yield* Workspace.AgentWorkspaceService;
        const request = yield* access.setThreadBinding(auth(), {
          accountId: created.account.id,
          credentialId: created.credential.id,
          attached: true,
        });
        expect((yield* workspace.listApprovals({ status: "pending" })).approvals[0]).toMatchObject({
          agentId: null,
          actionKind: "vault_use",
        });
        expect((yield* workspace.approve(request.approvalId!)).approval.status).toBe("approved");
        expect(
          (yield* (yield* Cli.CliCredentials).launch(auth(), "owner-approved")).env.GH_TOKEN,
        ).toBe(token);
        yield* access.removeAccess({
          id: created.account.id,
          scopeProjectId: project,
          credentialId: created.credential.id,
        });
        const next = yield* access.setThreadBinding(auth(), {
          accountId: created.account.id,
          credentialId: created.credential.id,
          attached: true,
        });
        yield* workspace.reject(next.approvalId!);
        expect(
          yield* (yield* Cli.CliCredentials).launch(auth(), "rejected").pipe(Effect.flip),
        ).toMatchObject({ reason: "denied" });
      }).pipe(
        Effect.provide(
          Workspace.layer.pipe(
            Layer.provideMerge(f.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(AgentService.AgentService)({}),
                Layer.mock(WorkHandoff.WorkHandoffService)({}),
                Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses identical account authorization from authenticated MCP and owner RPC service paths",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const created = yield* create("github");
          const mcp = yield* AccountsMcp.AccountsMcpService;
          const access = yield* Access.AccountAccess;
          const input = {
            accountId: created.account.id,
            credentialId: created.credential.id,
            attached: true,
          };
          const rpc = yield* access.setThreadBindingForThread(auth().threadId, input);
          const scope: Invocation.McpInvocationScope = {
            environmentId: EnvironmentId.make("machine:test"),
            issuedAt: 0,
            requestNamespace: "account-test",
            capabilities: new Set(["orchestration"]),
            client: undefined,
            thread: { ...auth(), providerSessionId: "session:test" },
          };
          expect(
            yield* mcp
              .use(input)
              .pipe(Effect.provideService(Invocation.McpInvocationContext, scope)),
          ).toEqual(rpc);
          const listed = yield* mcp
            .list("github")
            .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
          expect(listed.accounts.map((a) => a.id)).toEqual([created.account.id]);
          expect(JSON.stringify(listed)).not.toContain(token);
          f.scopes.set("outsider", ProjectLabelId.make("project:outsider"));
          const outside = {
            ...scope,
            thread: { ...scope.thread!, threadId: ThreadId.make("outsider") },
          };
          expect(
            (yield* mcp
              .list()
              .pipe(Effect.provideService(Invocation.McpInvocationContext, outside))).accounts,
          ).toEqual([]);
          expect(
            yield* mcp
              .disconnect({ accountId: created.account.id })
              .pipe(Effect.provideService(Invocation.McpInvocationContext, outside), Effect.flip),
          ).toMatchObject({ code: "invalid_request" });
        }).pipe(
          Effect.provide(
            AccountsMcp.layer.pipe(
              Layer.provideMerge(
                Connections.layer.pipe(
                  Layer.provideMerge(SecretRequests.layer.pipe(Layer.provideMerge(f.layer))),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "owns pending connections, captures private tokens idempotently, and verifies only after consent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const connections = yield* Connections.AccountConnections;
          const accounts = yield* Accounts.Accounts;
          const access = yield* Access.AccountAccess;
          const store = yield* ServerSecretStore.ServerSecretStore;
          f.scopes.set("unfiled", null);
          expect(
            yield* connections
              .connect(auth("unfiled"), { serviceId: "github", displayLabel: "Default" })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "project_required" });
          const first = yield* connections.connect(auth(), {
            serviceId: "cloudflare",
            displayLabel: "Public work label",
          });
          const retry = yield* connections.connect(auth(), {
            serviceId: "cloudflare",
            displayLabel: "Public work label",
          });
          expect(retry.connection.connectionId).toBe(first.connection.connectionId);
          yield* connections.bindSecretRequest(
            auth(),
            "private-card:one",
            first.connection.connectionId,
          );
          yield* connections.bindSecretRequest(
            auth(),
            "private-card:one",
            first.connection.connectionId,
          );
          expect(
            yield* connections.bindSecretRequest(auth(), "private-card:one").pipe(Effect.flip),
          ).toMatchObject({ reason: "conflict" });
          yield* connections.bindSecretRequest(auth(), "private-card:generic");
          expect(
            yield* connections
              .bindSecretRequest(auth(), "private-card:generic", first.connection.connectionId)
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "conflict" });
          const description = yield* connections.describe(auth(), first.connection.connectionId);
          expect(description.reason).toContain("Project: project:one");
          expect(description.reason).toContain(
            "The agent and the commands it runs can read this token",
          );
          expect(
            yield* connections
              .describe(auth("unrelated-thread"), first.connection.connectionId)
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
          const ref = SecretRef.make("secret-ref:" + "a".repeat(32));
          yield* store.create(
            "secret-request-" + "a".repeat(32),
            new TextEncoder().encode(
              JSON.stringify({ projectId: "project:mcp-test", value: token, savedAt: 0 }),
            ),
          );
          const saved = yield* connections.capture(auth(), first.connection.connectionId, ref);
          expect(saved.accountId).not.toBeNull();
          expect(yield* connections.capture(auth(), first.connection.connectionId, ref)).toEqual(
            saved,
          );
          expect(Option.isNone(yield* store.get("secret-request-" + "a".repeat(32)))).toBe(true);
          expect(JSON.stringify(saved)).not.toContain(token);
          expect((yield* accounts.list({ scopeProjectId: project })).accounts).toHaveLength(1);
          const ready = yield* connections.connect(auth(), {
            connectionId: first.connection.connectionId,
          });
          expect(ready.access?.status).toBe("approval_required");
          expect(f.processInputs).toHaveLength(0);
          yield* access.approve(ready.access!.approvalId!, "thread");
          expect(
            (yield* connections.connect(auth(), { connectionId: first.connection.connectionId }))
              .verification?.state,
          ).toBe("verified");
          const second = yield* connections.connect(auth(), {
            serviceId: "github",
            displayLabel: "Other",
          });
          expect(
            yield* connections
              .bindSecretRequest(auth(), "private-card:one", second.connection.connectionId)
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "conflict" });
          yield* accounts.cancelConnection(
            yield* access.caller(auth()),
            second.connection.connectionId,
          );
          expect(
            yield* connections.describe(auth(), second.connection.connectionId).pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
        }).pipe(
          Effect.provide(
            Connections.layer.pipe(
              Layer.provideMerge(SecretRequests.layer.pipe(Layer.provideMerge(f.layer))),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rolls back vault/account association together and keeps a failed private capture retryable",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const connections = yield* Connections.AccountConnections;
          const store = yield* ServerSecretStore.ServerSecretStore;
          const sql = yield* SqlClient.SqlClient;
          const connection = (yield* connections.connect(auth(), {
            serviceId: "github",
            displayLabel: "Work",
          })).connection;
          const ref = SecretRef.make("secret-ref:" + "b".repeat(32));
          const name = "secret-request-" + "b".repeat(32);
          yield* store.create(
            name,
            new TextEncoder().encode(
              JSON.stringify({ projectId: "project:mcp-test", value: token, savedAt: 0 }),
            ),
          );
          yield* sql`CREATE TRIGGER fail_account_store BEFORE INSERT ON accounts BEGIN SELECT RAISE(FAIL, 'synthetic storage failure'); END`;
          expect(
            yield* connections.capture(auth(), connection.connectionId, ref).pipe(Effect.flip),
          ).toMatchObject({ reason: "storage" });
          expect(yield* sql`SELECT id FROM vault_items`).toEqual([]);
          expect(yield* sql`SELECT id FROM accounts`).toEqual([]);
          expect(Option.isSome(yield* store.get(name))).toBe(true);
          yield* sql`DROP TRIGGER fail_account_store`;
          const saved = yield* connections.capture(auth(), connection.connectionId, ref);
          expect(saved.accountId).not.toBeNull();
          expect(yield* sql`SELECT id FROM vault_items`).toHaveLength(1);
          expect(yield* sql`SELECT id FROM accounts`).toHaveLength(1);
          expect(Option.isNone(yield* store.get(name))).toBe(true);
          expect(JSON.stringify(yield* sql`SELECT payload_json FROM accounts`)).not.toContain(
            token,
          );
          expect(JSON.stringify(yield* sql`SELECT * FROM account_connections`)).not.toContain(
            token,
          );
        }).pipe(
          Effect.provide(
            Connections.layer.pipe(
              Layer.provideMerge(SecretRequests.layer.pipe(Layer.provideMerge(f.layer))),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "verifies using a replacement environment and empty CLI homes; reports bounded failure categories",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const created = yield* create("github");
          const cli = yield* Cli.CliCredentials;
          yield* attach(created);
          for (const [output, expected] of [
            [{ code: 0 }, "verified"],
            [{ code: 1, stderr: "token expired" }, "expired"],
            [{ code: 1, stderr: "403 insufficient scope" }, "insufficient_scope"],
            [{ code: 1, stderr: "ENOTFOUND" }, "network_failure"],
          ] as const) {
            f.setOutput(output as Partial<ProcessRunner.ProcessRunOutput>);
            const status = yield* cli.verify(auth(), created.account.id, created.credential.id);
            expect(status.state).toBe(expected);
            expect(JSON.stringify(status)).not.toContain(token);
          }
          f.setMissing();
          expect((yield* cli.verify(auth(), created.account.id, created.credential.id)).state).toBe(
            "cli_missing",
          );
          yield* (yield* Vault.Vault).update({
            id: created.item.id,
            secretFields: { value: "synthetic-replacement-for-status" },
          });
          expect(
            (yield* (yield* Accounts.Accounts).list({ scopeProjectId: project })).statuses[0],
          ).toMatchObject({ state: "unknown", reason: "credential_changed" });
          for (const input of f.processInputs) {
            expect(input.command).toBe("gh");
            expect(input.args).toEqual(["auth", "status"]);
            expect(input.extendEnv).toBe(false);
            expect(input.env?.GH_TOKEN).toBe(token);
            expect(input.env?.GITHUB_TOKEN).toBeUndefined();
            expect(input.env?.HOME).not.toBe("/synthetic-real-home");
            expect(input.env?.GH_CONFIG_DIR).toBe(input.env?.HOME);
            expect(JSON.stringify(input.args)).not.toContain(token);
          }
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(HostProcess.Environment, {
            PATH: "/bin",
            HOME: "/synthetic-real-home",
            GITHUB_TOKEN: "ambient-github-token",
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalFetch:off globalDate:off globalDateInEffect:off globalConsole:off - Dev-only seeding script run by hand.
/**
 * Dev-only: fills a development server with chats, project threads, and
 * scheduled-task agents so the sidebar's Chats / Tasks / Agents modes have
 * something to show. Creates threads with `thread.create`, which never starts
 * a provider run, so seeding spends no model tokens.
 *
 *   node apps/server/scripts/dev-seed-sidebar.ts \
 *     --http http://127.0.0.1:<server port> --token-file <file> --repos-dir <dir>
 *
 * Mint the token against the dev home only, never a live one:
 *   node apps/server/src/bin.ts auth session issue --base-dir <dev home> --token-only
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  type ScheduledTaskUpsertInput,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const { values } = NodeUtil.parseArgs({
  options: {
    http: { type: "string" },
    "token-file": { type: "string" },
    "repos-dir": { type: "string" },
  },
});
const httpBase = values.http ?? "http://127.0.0.1:4773";
const token = NodeFS.readFileSync(values["token-file"] ?? "", "utf8").trim();
const reposDir = values["repos-dir"] ?? "/tmp/t3-dev-seed-repos";

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const commandId = () => CommandId.make(id("seed-cmd"));

function makeRepo(name: string): string {
  const root = NodePath.join(reposDir, name);
  NodeFS.mkdirSync(root, { recursive: true });
  if (!NodeFS.existsSync(NodePath.join(root, ".git"))) {
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), `# ${name}\n`);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-qm", "init");
  }
  return root;
}

async function socketUrl(): Promise<string> {
  const response = await fetch(`${httpBase}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`websocket ticket: HTTP ${response.status}`);
  const { ticket } = (await response.json()) as { ticket: string };
  const url = new URL("/ws", httpBase.replace(/^http/, "ws"));
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  // Seeded threads and tasks use a model the live catalog actually offers: the
  // provider's default, preferring Codex, so texting a seeded agent can succeed.
  yield* client[WS_METHODS.serverRefreshProviders]({}).pipe(Effect.ignore);
  const { providers } = yield* client[WS_METHODS.serverGetConfig]({});
  const provider = ["codex", "claudeAgent"]
    .flatMap((driver) =>
      providers.filter((candidate) => candidate.driver === driver && candidate.enabled),
    )
    .find((candidate) => candidate.models.some((model) => !model.isCustom));
  if (provider === undefined)
    return yield* Effect.die("Enable a Codex or Claude provider before seeding.");
  const builtIn = provider.models.filter((model) => !model.isCustom);
  const modelSelection = {
    instanceId: provider.instanceId,
    model: (builtIn.find((model) => model.isDefault) ?? builtIn[0])!.slug,
  } as never;
  const dispatch = (command: Record<string, unknown>) =>
    client["orchestration.dispatchCommand"]({
      commandId: commandId(),
      ...command,
    } as never);

  const createProject = (title: string, workspaceRoot: string) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(id("seed-project"));
      yield* client[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title,
        workspaceRoot,
      });
      return projectId;
    });

  const createThread = (projectId: ProjectId, title: string, branch: string | null = null) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(id("seed-thread"));
      yield* dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch,
        worktreePath: null,
      });
      return threadId;
    });

  const createAgent = (
    projectId: ProjectId,
    title: string,
    prompt: string,
    schedule: ScheduledTaskUpsertInput["schedule"],
    enabled = true,
  ) =>
    Effect.gen(function* () {
      const threadId = yield* createThread(projectId, title);
      const { task } = yield* client[WS_METHODS.scheduledTasksUpsert]({
        title,
        prompt,
        enabled,
        schedule,
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      return { threadId, taskId: task.id };
    });

  const { projectId: scratchId } = yield* client[WS_METHODS.projectsEnsureScratch]({});
  const web = yield* createProject("acme-web", makeRepo("acme-web"));
  const api = yield* createProject("billing-api", makeRepo("billing-api"));

  const chats = [
    "Recipe ideas for a dinner party of six",
    "Explain Rust lifetimes like I'm five",
    "Draft a polite reply to the landlord",
    "Compare three espresso grinders under $400",
    "Lisbon trip plan for March",
    "Summarize the Q3 board deck",
  ];
  const chatIds: ThreadId[] = [];
  for (const title of chats) chatIds.push(yield* createThread(scratchId, title));

  const webThreads = [
    ["Fix flaky checkout e2e test", "fix/checkout-e2e"],
    ["Migrate settings page to the new form library", "feat/settings-forms"],
    ["Investigate slow dashboard query", null],
    ["Add dark mode to marketing site", "feat/marketing-dark"],
  ] as const;
  const webIds: ThreadId[] = [];
  for (const [title, branch] of webThreads) webIds.push(yield* createThread(web, title, branch));
  const apiIds: ThreadId[] = [];
  for (const [title, branch] of [
    ["Add idempotency keys to webhook handlers", "feat/idempotency"],
    ["Upgrade the Stripe SDK to v18", "chore/stripe-18"],
    ["Write runbook for refund failures", null],
  ] as const) {
    apiIds.push(yield* createThread(api, title, branch));
  }
  yield* dispatch({
    type: "thread.snooze",
    threadId: webIds[3],
    snoozedUntil: new Date(Date.now() + 26 * 3600_000).toISOString(),
  });
  yield* dispatch({ type: "thread.settle", threadId: apiIds[2] });
  yield* dispatch({ type: "thread.settle", threadId: chatIds[5] });

  const agents = [
    yield* createAgent(
      web,
      "Nightly dependency audit",
      "Check for outdated or vulnerable dependencies and open a summary.",
      { type: "fixed_time", timeOfDay: "02:00" },
    ),
    yield* createAgent(
      web,
      "PR review sweeper",
      "Review open pull requests that have had no review for a day.",
      { type: "interval", everyMs: 30 * 60_000 },
    ),
    yield* createAgent(
      api,
      "Failed payment triage",
      "Look at failed payments from the last hour and group them by cause.",
      { type: "interval", everyMs: 60 * 60_000 },
    ),
    yield* createAgent(
      api,
      "Weekly changelog writer",
      "Write the weekly changelog from merged pull requests.",
      { type: "fixed_time", timeOfDay: "16:00", weekdays: [5] },
      false,
    ),
    yield* createAgent(
      scratchId,
      "Morning news digest",
      "Summarize the top stories in AI and developer tools.",
      { type: "fixed_time", timeOfDay: "08:00", weekdays: [1, 2, 3, 4, 5] },
    ),
  ];

  return { modelSelection, scratchId, web, api, chatIds, webIds, apiIds, agents };
}).pipe(Effect.scoped);

const url = await socketUrl();
const layer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);
const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
console.log(JSON.stringify(result, null, 2));
process.exit(0);

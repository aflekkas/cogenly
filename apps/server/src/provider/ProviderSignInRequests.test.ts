import { NodeCrypto as EffectNodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineInfo,
  type MachineListResult,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Machines from "../machines/Machines.ts";
import type * as Invocation from "../mcp/McpInvocationContext.ts";
import * as InlineCardNotifications from "../orchestration-v2/InlineCardNotifications.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderSignInRequests from "./ProviderSignInRequests.ts";

const threadId = ThreadId.make("thread:sign-in");
const claude = ProviderInstanceId.make("claude-uchicago");
const vps = EnvironmentId.make("env-vps");

const machine = (
  name: string,
  relation: MachineInfo["relation"],
  auth: "authenticated" | "unauthenticated",
  overrides: Partial<MachineInfo> = {},
): MachineInfo => ({
  environmentId: EnvironmentId.make(`env-${name.toLowerCase()}`),
  name,
  kind: relation === "this" ? "this-computer" : "cloud-server",
  hardware: relation === "this" ? "laptop" : "server",
  platform: "darwin",
  providers: [{ instanceId: claude, displayName: "Claude (UChicago)", enabled: true, auth }],
  relation,
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
  ...overrides,
});

const list = (vpsAuth: "authenticated" | "unauthenticated"): MachineListResult => ({
  machines: [machine("MacBook", "this", "authenticated"), machine("VPS", "hub", vpsAuth)],
  link: { _tag: "spoke", hubEnvironmentId: vps, status: "online", route: null, lastError: null },
});

const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-macbook"),
  requestNamespace: "provider:thread",
  thread: { threadId, providerSessionId: "session", providerInstanceId: claude },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const card = {
  id: "turn-item:provider-sign-in:1",
  type: "secret_request",
  runId: RunId.make("run:1"),
  nodeId: NodeId.make("node:1"),
  label: "Sign in to Claude (UChicago) on VPS",
  reason: "Finish signing in here.",
  secretStatus: "pending",
  providerSignIn: {
    instanceId: claude,
    targetEnvironmentId: vps,
    providerName: "Claude (UChicago)",
    machineName: "VPS",
  },
};

const harness = (options: {
  readonly lists: Queue.Queue<MachineListResult>;
  readonly current: MachineListResult;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly recorded: Array<OrchestrationV2ServerCommand>;
  readonly answered: Deferred.Deferred<string>;
}) =>
  ProviderSignInRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Machines.Machines)({
          list: Effect.succeed(options.current),
          subscribe: Stream.fromQueue(options.lists),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { deletedAt: null, archivedAt: null },
              turnItems: options.turnItems ?? [],
              runs: [
                {
                  id: RunId.make("run:1"),
                  rootNodeId: NodeId.make("node:1"),
                  status: "running",
                  providerInstanceId: claude,
                },
              ],
            } as never),
          dispatch: (command) =>
            Effect.sync(() => {
              options.recorded.push(command);
              return {} as never;
            }),
        }),
        Layer.succeed(
          InlineCardNotifications.InlineCardNotifications,
          InlineCardNotifications.InlineCardNotifications.of({
            answered: (input) =>
              Deferred.succeed(options.answered, input.summary).pipe(Effect.asVoid),
          }),
        ),
        EffectNodeCrypto.layer,
      ),
    ),
  );

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

describe("ProviderSignInRequests", () => {
  it.effect("posts one inline card naming the provider and the machine to sign in on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const recorded: Array<OrchestrationV2ServerCommand> = [];
        const requests = yield* ProviderSignInRequests.ProviderSignInRequests.pipe(
          Effect.provide(
            harness({
              lists: yield* Queue.unbounded<MachineListResult>(),
              current: list("unauthenticated"),
              recorded,
              answered: yield* Deferred.make<string>(),
            }),
          ),
        );
        const result = yield* requests.request(scope, {
          instanceId: claude,
          targetEnvironmentId: vps,
        });
        expect(result).toMatchObject({ _tag: "Posted", request: { machineName: "VPS" } });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          type: "secret_request.record",
          secretStatus: "pending",
          label: "Sign in to Claude (UChicago) on VPS",
          providerSignIn: { instanceId: claude, targetEnvironmentId: vps },
        });
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("posts nothing when the machine is already signed in or can't sign in here", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const recorded: Array<OrchestrationV2ServerCommand> = [];
        const build = (current: MachineListResult) =>
          Effect.gen(function* () {
            return yield* ProviderSignInRequests.ProviderSignInRequests.pipe(
              Effect.provide(
                harness({
                  lists: yield* Queue.unbounded<MachineListResult>(),
                  current,
                  recorded,
                  answered: yield* Deferred.make<string>(),
                }),
              ),
            );
          });
        const signedIn = yield* build(list("authenticated"));
        expect(
          yield* signedIn.request(scope, { instanceId: claude, targetEnvironmentId: vps }),
        ).toEqual({ _tag: "AlreadySignedIn", machineName: "VPS" });
        const external = yield* build({
          ...list("unauthenticated"),
          machines: [
            machine("MacBook", "this", "authenticated"),
            machine("VPS", "hub", "unauthenticated", {
              providers: [
                {
                  instanceId: claude,
                  displayName: "Muse",
                  enabled: true,
                  auth: "unauthenticated",
                  canAuthenticate: false,
                },
              ],
            }),
          ],
        });
        const failure = yield* external
          .request(scope, { instanceId: claude, targetEnvironmentId: vps })
          .pipe(Effect.flip);
        expect(failure.message).toContain("can't sign in from Cogenly");
        expect(recorded).toEqual([]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("closes a pending card and wakes its thread once that machine signs in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json) VALUES (${card.id}, ${threadId}, ${card.runId}, ${card.nodeId}, 1, 'secret_request', 'waiting', '2026-10-26T00:00:00.000Z', ${JSON.stringify(card)})`;
        const lists = yield* Queue.unbounded<MachineListResult>();
        const recorded: Array<OrchestrationV2ServerCommand> = [];
        const answered = yield* Deferred.make<string>();
        // The watcher lives as long as the service's layer, so the sign-in happens inside it.
        yield* Effect.gen(function* () {
          yield* ProviderSignInRequests.ProviderSignInRequests;
          // A list where that machine is still signed out leaves the card open.
          yield* Queue.offer(lists, list("unauthenticated"));
          yield* Queue.offer(lists, list("authenticated"));
          expect(yield* Deferred.await(answered)).toBe("Claude (UChicago) is signed in on VPS");
        }).pipe(
          Effect.provide(
            harness({
              lists,
              current: list("unauthenticated"),
              turnItems: [card],
              recorded,
              answered,
            }),
          ),
        );
        expect(recorded).toEqual([
          expect.objectContaining({
            type: "secret_request.record",
            turnItemId: card.id,
            secretStatus: "saved",
          }),
        ]);
      }),
    ).pipe(Effect.provide(database)),
  );
});

import { createExportAtoms } from "./exports.ts";
import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createAgentWorkspaceAtoms } from "./agents.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("forks on a paired machine only with the request environment's operate grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fork = createCommandPermissions(runtime, WS_METHODS.machinesForkThread);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(registry.get(fork.permissionAtom(env))).toBe(false);
        expect(yield* fork.authorize(registry, env).pipe(Effect.flip)).toMatchObject({
          requiredScope: AuthOrchestrationOperateScope,
        });
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(fork.permissionAtom(env))).toBe(true);
        yield* fork.authorize(registry, env);
      }),
    ),
  );
  it.effect("executes guarded read queries only with the destination read grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        let calls = 0;
        const supervisor = {
          target: { environmentId: env, label: "test" },
          state: yield* SubscriptionRef.make({ phase: "connected" }),
          session: yield* SubscriptionRef.make(
            Option.some({
              client: {
                [WS_METHODS.searchQuery]: () =>
                  Effect.sync(() => {
                    calls++;
                    return { results: [] };
                  }),
              },
            }),
          ),
        } as unknown as EnvironmentSupervisor["Service"];
        const queryRuntime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id, effect) =>
              effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
            followStream: (_id, stream) =>
              stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
          } as EnvironmentRegistry["Service"]),
        );
        const query = createEnvironmentGuardedRpcQueryAtomFamily(queryRuntime, {
          label: "test.search",
          tag: WS_METHODS.searchQuery,
        });
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        const denied = yield* AtomRegistry.getResult(
          registry,
          query({ environmentId: env, input: { query: "denied" } }),
        ).pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthOrchestrationReadScope,
        });
        expect(calls).toBe(0);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        const allowed = yield* AtomRegistry.getResult(
          registry,
          query({ environmentId: env, input: { query: "allowed" } }),
        );
        expect(allowed).toEqual({ results: [] });
        expect(calls).toBe(1);
      }),
    ),
  );

  it.effect("guards visual state reads with the destination read grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, WS_METHODS.visualStateGet);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect((yield* permission.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationReadScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        yield* permission.authorize(registry, env);
      }),
    ),
  );

  it.effect("shows a thread's pending approvals with the read grant; deciding needs operate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const see = createCommandPermissions(runtime, WS_METHODS.threadApprovalsSubscribe);
        const decide = createCommandPermissions(runtime, WS_METHODS.agentsApprove);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(see.permissionAtom(env))).toBe(true);
        expect(registry.get(decide.permissionAtom(env))).toBe(false);
        expect((yield* decide.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationOperateScope,
        );
      }),
    ),
  );

  it.effect("guards search with the destination read grant without requiring operate access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, WS_METHODS.searchQuery);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect((yield* permission.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationReadScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        yield* permission.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(other))).toBe(false);
      }),
    ),
  );
  it.effect("the agent approval command refuses execution without an owner grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        const commands = createAgentWorkspaceAtoms(runtime);
        const result = yield* Effect.promise(() =>
          commands.agentsApprove.run(registry, {
            environmentId: env,
            input: { id: "approval:test" },
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain("EnvironmentAuthorizationError");
      }),
    ),
  );

  it.effect.each([
    WS_METHODS.projectLabelsCreate,
    WS_METHODS.projectLabelsUpdate,
    WS_METHODS.projectLabelsDelete,
    WS_METHODS.projectLabelsArchive,
    WS_METHODS.projectLabelsUnarchive,
    WS_METHODS.projectLabelsLinkRepository,
    WS_METHODS.projectLabelsUnlinkRepository,
    WS_METHODS.projectLabelsMoveThread,
    WS_METHODS.machinesPreviewMoveThreads,
    WS_METHODS.machinesPreviewMoveAllThreads,
    WS_METHODS.projectLabelsPreviewMoveToMachine,
    WS_METHODS.projectLabelsForkThreadToProject,
    WS_METHODS.projectLabelsSetThreadLabels,
    WS_METHODS.projectLabelsAddResource,
    WS_METHODS.projectLabelsRemoveResource,
    WS_METHODS.projectLabelsEnsureProjectChat,
    WS_METHODS.workStart,
    WS_METHODS.agentsRequestApproval,
    WS_METHODS.agentsApprove,
    WS_METHODS.agentsReject,
    WS_METHODS.agentsStartWork,
    WS_METHODS.factsCreate,
    WS_METHODS.factsUpdate,
    WS_METHODS.factsSupersede,
    WS_METHODS.factsRetract,
    WS_METHODS.contextSetEnabled,
    WS_METHODS.commitmentsCreate,
    WS_METHODS.commitmentsUpdateStatus,
    WS_METHODS.commitmentsConfirm,
    WS_METHODS.commitmentsDismiss,
    WS_METHODS.commitmentsDelete,
    WS_METHODS.agentsUpsert,
    WS_METHODS.agentsDelete,
    WS_METHODS.agentsSend,
    WS_METHODS.agentsMarkRead,
    WS_METHODS.agentsSetProject,
    WS_METHODS.agentsMemoryWrite,
    WS_METHODS.agentsMemoryForget,
    WS_METHODS.visualStateSet,
    WS_METHODS.visualStateSubmit,
  ])("requires the destination operate grant for %s", (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, method);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect((yield* permission.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        yield* permission.authorize(registry, env);
      }),
    ),
  );

  it.effect("requires access management authority to recover lost-machine threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const recovery = createCommandPermissions(runtime, WS_METHODS.machinesAdoptThreads);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(recovery.permissionAtom(env))).toBe(false);
        expect(yield* recovery.authorize(registry, env).pipe(Effect.flip)).toMatchObject({
          requiredScope: AuthAccessWriteScope,
        });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthAccessWriteScope],
            permissions: [AuthAccessWriteScope],
          }),
        );
        expect(registry.get(recovery.permissionAtom(env))).toBe(true);
        yield* recovery.authorize(registry, env);
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
  it.effect("exports refuse execution without the Settings grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const commands = createExportAtoms(runtime);
        const results = [
          yield* Effect.promise(() =>
            commands.exportCreate.run(registry, {
              environmentId: env,
              input: { include: ["chats"] },
            }),
          ),
          yield* Effect.promise(() =>
            commands.exportValidate.run(registry, {
              environmentId: env,
              input: { path: "/ignored" },
            }),
          ),
          yield* Effect.promise(() =>
            commands.exportList.run(registry, { environmentId: env, input: {} }),
          ),
        ];
        expect(results.every((result) => result._tag === "Failure")).toBe(true);
      }),
    ),
  );
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("gates cloning a project's linked repository here on the source control grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const checkout = createCommandPermissions(
        runtime,
        WS_METHODS.projectLabelsCheckoutRepository,
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        }),
      );
      expect(registry.get(checkout.permissionAtom(env))).toBe(false);
      expect((yield* checkout.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
        AuthSourceControlWriteScope,
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        }),
      );
      expect(registry.get(checkout.permissionAtom(env))).toBe(true);
    }),
  ),
);

it.effect(
  "gates removing and moving checkouts on source control, and orphan folders on operate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const sourceControl = [
          WS_METHODS.projectLabelsRemoveCheckout,
          WS_METHODS.projectLabelsAdoptRepository,
        ].map((method) => createCommandPermissions(runtime, method));
        const operate = [
          WS_METHODS.projectLabelsAdoptOrphanFolder,
          WS_METHODS.projectLabelsRemoveOrphanFolder,
        ].map((method) => createCommandPermissions(runtime, method));
        const holding = (
          scope: typeof AuthOrchestrationOperateScope | typeof AuthSourceControlWriteScope,
        ) =>
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(false), scopes: [scope], permissions: [scope] }),
          );
        holding(AuthOrchestrationOperateScope);
        for (const command of sourceControl) {
          expect(registry.get(command.permissionAtom(env))).toBe(false);
          expect(
            (yield* command.authorize(registry, env).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthSourceControlWriteScope);
        }
        for (const command of operate) expect(registry.get(command.permissionAtom(env))).toBe(true);
        holding(AuthSourceControlWriteScope);
        for (const command of sourceControl)
          expect(registry.get(command.permissionAtom(env))).toBe(true);
        for (const command of operate) {
          expect(registry.get(command.permissionAtom(env))).toBe(false);
          expect(
            (yield* command.authorize(registry, env).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthOrchestrationOperateScope);
        }
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

import {
  ProviderSetupError,
  ProviderMachineAuth,
  type ProviderMachineAuthRequest,
  type EnvironmentId,
  type ProjectId,
  type SecretRef,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderAuthCancelInput,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  type ProviderAuthState,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@cogenly/contracts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type { ProviderAuthController } from "@cogenly/provider-core/server/auth";

export type { ProviderAuthController } from "@cogenly/provider-core/server/auth";

const decodeProviderSetupError = Schema.decodeUnknownOption(ProviderSetupError);

interface ProviderAuthTarget {
  readonly instanceId: ProviderInstanceId;
  readonly targetEnvironmentId?: EnvironmentId;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  {
    readonly manageSignIn: (
      request: ProviderMachineAuthRequest,
      owner: string,
      code?: { readonly ref: SecretRef; readonly projectId: ProjectId },
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError, SecretRequests.SecretRequests>;
    readonly reconnectProfile: (
      input: ProviderAuthTarget & { methodId: string },
    ) => Effect.Effect<ChatGptReconnectProfile | null, ProviderSetupError>;
    readonly importProfile: (
      input: ProviderAuthTarget & { profile: ChatGptTransferredProfile },
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly start: (
      input: ProviderAuthStartInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly complete: (
      input: ProviderAuthTarget & { readonly flowId: string; readonly callbackUrl: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly respond: (
      input: ProviderAuthRespondInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderAuthCancelInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly logout: (
      input: ProviderAuthTarget,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderAuthTarget,
      ownerSessionId: string,
    ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
    readonly tryHandlePromptCommand: (
      input: ProviderAuthTarget & { readonly text: string; readonly hasAttachments: boolean },
    ) => Effect.Effect<boolean, ProviderSetupError>;
  }
>()("cogenly-server/provider/ProviderAuthService") {}

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const credentialChanges = yield* Semaphore.make(1);

  const getController = Effect.fn("ProviderAuthService.getController")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.auth) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This provider does not support sign-in in Cogenly."
          : "This provider instance is no longer available.",
      });
    }
    return instance.auth;
  });

  // Native sessions may still belong to the previous provider after the
  // selected model changes. Read session bindings, not the selected model,
  // when invalidating credentials for sign-in or sign-out.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
    binding: ProviderAuthController["credentialBinding"],
  ) {
    const failure = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "stopSessions", detail });
    const affectedIds = new Set([
      instanceId,
      ...(binding === undefined
        ? []
        : (yield* registry.listInstances)
            .filter(
              (instance) =>
                instance.auth?.credentialBinding?.key === binding.key &&
                instance.auth.credentialBinding.owner === binding.owner,
            )
            .map((instance) => instance.instanceId)),
    ]);
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(() => failure("Could not read the provider's active sessions. Try again.")),
      );
    const released = new Set<ProviderSessionId>();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
          Effect.flatMap((projection) =>
            Effect.forEach(
              projection.providerSessions.filter(
                (session) =>
                  affectedIds.has(session.providerInstanceId) &&
                  session.status !== "stopped" &&
                  session.status !== "error" &&
                  !released.has(session.id),
              ),
              (session) =>
                Effect.gen(function* () {
                  if (session.providerInstanceId !== instanceId) {
                    const current = yield* registry.getInstance(session.providerInstanceId);
                    if (
                      !binding ||
                      current?.auth?.credentialBinding?.key !== binding.key ||
                      current.auth.credentialBinding.owner !== binding.owner
                    )
                      return;
                  }
                  yield* providerSessions
                    .release({
                      providerSessionId: session.id,
                      reason: "manual_shutdown",
                      detail: "Provider sign-in changed.",
                    })
                    .pipe(Effect.tap(() => Effect.sync(() => released.add(session.id))));
                }),
              { discard: true },
            ),
          ),
          Effect.mapError(() =>
            failure("Could not stop all sessions for this provider. Try again."),
          ),
        ),
      { discard: true },
    );
    if (binding) {
      yield* Effect.forEach(
        (yield* registry.listInstances).filter(
          (instance) =>
            instance.instanceId !== instanceId &&
            affectedIds.has(instance.instanceId) &&
            instance.auth?.credentialBinding?.key === binding.key &&
            instance.auth.credentialBinding.owner === binding.owner,
        ),
        (instance) => instance.auth?.invalidate ?? Effect.void,
        { discard: true },
      );
    }
  });

  const checkSharedBinding = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    operation: "start" | "logout",
    auth: ProviderAuthController,
  ) {
    const binding = auth.credentialBinding;
    if (!binding) return;
    const instances = yield* registry.listInstances;
    for (const instance of instances) {
      if (
        instance.instanceId !== instanceId &&
        instance.auth?.credentialBinding?.key === binding.key &&
        instance.auth.credentialBinding.owner === binding.owner &&
        instance.auth.isChangingCredentials &&
        (yield* instance.auth.isChangingCredentials)
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation,
          detail:
            "Another provider instance is changing this shared sign-in. Finish or cancel it first.",
        });
      }
    }
  });

  const local: Omit<ProviderAuthService["Service"], "manageSignIn"> = {
    reconnectProfile: Effect.fnUntraced(function* (input) {
      const auth = yield* getController(input.instanceId, "export");
      if (!auth.reconnectProfile)
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "export",
          detail: "This provider does not support ChatGPT profile transfer.",
        });
      return yield* auth.reconnectProfile(input.methodId);
    }),
    importProfile: (input) =>
      credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "import");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          if (!auth.importProfile)
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "import",
              detail: "This provider does not support ChatGPT profile transfer.",
            });
          return yield* auth.importProfile(
            input.profile,
            stopSessions(input.instanceId, auth.credentialBinding),
          );
        }),
      ),
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "start");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          return yield* auth.start(
            ownerSessionId,
            stopSessions(input.instanceId, auth.credentialBinding),
            input.methodId,
            input.returnUrl,
            input.callbackMode,
          );
        }),
      );
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "respond");
      if (!auth.respond) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "respond",
          detail: "This provider does not accept this sign-in interaction.",
        });
      }
      return yield* auth.respond(ownerSessionId, input);
    }),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "complete");
      return yield* auth.complete(ownerSessionId, input);
    }),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "cancel");
      return yield* auth.cancel(ownerSessionId, input.flowId, input.flowEpoch);
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "logout");
          yield* checkSharedBinding(input.instanceId, "logout", auth);
          return yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
        }),
      );
    }),
    subscribe: (input, ownerSessionId) =>
      Effect.gen(function* () {
        const changes = yield* registry.subscribeChanges;
        const initial = yield* getController(input.instanceId, "subscribe");
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, "subscribe")),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId)),
        );
      }).pipe(Stream.unwrap),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(
      function* (input) {
        const instance = yield* registry.getInstance(input.instanceId);
        if (!instance?.auth?.isLogoutPrompt?.(input.text, input.hasAttachments)) {
          return false;
        }
        return yield* credentialChanges.withPermit(
          Effect.gen(function* () {
            const auth = yield* getController(input.instanceId, "logout");
            if (!auth.isLogoutPrompt?.(input.text, input.hasAttachments)) return false;
            yield* checkSharedBinding(input.instanceId, "logout", auth);
            yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
            return true;
          }),
        );
      },
    ),
  };
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const execute = (
    request: ProviderMachineAuthRequest,
    owner: string,
  ): Effect.Effect<ProviderAuthState, ProviderSetupError> => {
    const { targetEnvironmentId: _target, ...input } = request.input;
    switch (request.operation) {
      case "start":
        return local.start(request.input, owner);
      case "respond":
        return local.respond(request.input, owner);
      case "complete":
        return local.complete(request.input, owner);
      case "cancel":
        return local.cancel(request.input, owner);
      case "logout":
        return local.logout(input);
      case "read":
        return Stream.runHead(local.subscribe(input, owner)).pipe(
          Effect.flatMap((state) =>
            Option.isSome(state)
              ? Effect.succeed(state.value)
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "read",
                    detail: "Sign-in state is unavailable.",
                  }),
                ),
          ),
        );
    }
  };
  const unreachable = (request: ProviderMachineAuthRequest) =>
    new ProviderSetupError({
      instanceId: request.input.instanceId,
      operation: request.operation,
      detail:
        "The paired machine could not complete this sign-in action. Check its connection and try again.",
    });
  const remote = (target: EnvironmentId, request: ProviderMachineAuthRequest, owner: string) =>
    Effect.gen(function* () {
      const list = yield* machines.list;
      if (
        list.machines.some(
          (machine) => machine.environmentId === target && machine.relation === "this",
        )
      )
        return yield* execute(request, owner);
      const destination =
        list.link._tag === "spoke" &&
        list.machines.some(
          (machine) => machine.environmentId === target && machine.relation === "peer",
        )
          ? list.link.hubEnvironmentId
          : target;
      return yield* machines.call(destination, ProviderMachineAuth, { owner, request }).pipe(
        Effect.catchTags({
          PeerCallError: (error) => {
            if (error.reason === "invalid-payload" || error.reason === "unknown-channel")
              return Effect.fail(
                new ProviderSetupError({
                  instanceId: request.input.instanceId,
                  operation: request.operation,
                  detail: "Update Cogenly on the other machine to use this sign-in action.",
                }),
              );
            if (error.reason === "handler-failed" && error.error !== undefined) {
              const decoded = decodeProviderSetupError(error.error);
              if (Option.isSome(decoded)) return Effect.fail(decoded.value);
            }
            return Effect.fail(unreachable(request));
          },
        }),
      );
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ProviderSetupError" ? error : unreachable(request),
      ),
    );
  yield* channels.register(ProviderMachineAuth, ({ owner, request }, caller) =>
    Effect.gen(function* () {
      const namespacedOwner = `${caller.environmentId}:${owner}`;
      const list = yield* machines.list.pipe(Effect.mapError(() => unreachable(request)));
      const target = request.input.targetEnvironmentId;
      const self = list.machines.find((machine) => machine.relation === "this");
      if (target && target !== self?.environmentId) {
        // Only a hub forwards a spoke's request to another directly paired spoke.
        // A spoke never forwards again, so a bad target cannot create a routing loop.
        if (
          list.link._tag !== "hub" ||
          !list.machines.some(
            (machine) => machine.environmentId === target && machine.relation === "spoke",
          )
        )
          return yield* unreachable(request);
        return yield* remote(target, request, namespacedOwner);
      }
      return yield* execute(request, namespacedOwner);
    }),
  );
  return ProviderAuthService.of({
    ...local,
    manageSignIn: (request, owner, code) => {
      const run = (value: ProviderMachineAuthRequest) =>
        value.input.targetEnvironmentId
          ? remote(value.input.targetEnvironmentId, value, owner)
          : execute(value, owner);
      if (!code) return run(request);
      if (request.operation !== "respond" || request.input.response.type !== "credentials")
        return Effect.fail(unreachable(request));
      const input = request.input;
      return Effect.gen(function* () {
        const secrets = yield* SecretRequests.SecretRequests;
        return yield* secrets
          .adopt(code, (value) =>
            run({
              operation: "respond",
              input: { ...input, response: { type: "credentials", values: { code: value } } },
            }),
          )
          .pipe(Effect.mapError(() => unreachable(request)));
      });
    },
    start: (input, owner) =>
      input.targetEnvironmentId
        ? remote(input.targetEnvironmentId, { operation: "start", input }, owner)
        : local.start(input, owner),
    respond: (input, owner) =>
      input.targetEnvironmentId
        ? remote(input.targetEnvironmentId, { operation: "respond", input }, owner)
        : local.respond(input, owner),
    complete: (input, owner) =>
      input.targetEnvironmentId
        ? remote(input.targetEnvironmentId, { operation: "complete", input }, owner)
        : local.complete(input, owner),
    cancel: (input, owner) =>
      input.targetEnvironmentId
        ? remote(input.targetEnvironmentId, { operation: "cancel", input }, owner)
        : local.cancel(input, owner),
    logout: (input) =>
      input.targetEnvironmentId
        ? remote(input.targetEnvironmentId, { operation: "logout", input }, "logout")
        : local.logout(input),
    subscribe: (input, owner) =>
      input.targetEnvironmentId
        ? Stream.fromEffect(
            remote(input.targetEnvironmentId, { operation: "read", input }, owner),
          ).pipe(
            Stream.repeat(Schedule.spaced("1 second")),
            Stream.changesWith<ProviderAuthState>((a, b) => Equal.equals(a, b)),
          )
        : local.subscribe(input, owner),
  });
});

export const layer = Layer.effect(ProviderAuthService, makeProviderAuthService);

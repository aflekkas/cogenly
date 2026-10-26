/**
 * ProviderSignInRequests - provider sign-ins an agent hands to the user.
 *
 * provider_sign_in start from a thread posts an inline card instead of
 * starting a flow the agent would own. The card runs the user's own sign-in
 * on the named machine, so the browser step and the code stay on the user's
 * device and never reach the transcript. Once that machine reports the
 * provider signed in, the card closes and the thread wakes, even if the agent's
 * turn ended long before.
 *
 * @module ProviderSignInRequests
 */
import {
  CommandId,
  type EnvironmentId,
  type MachineListResult,
  type OrchestrationV2ProviderSignInRequest,
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Machines from "../machines/Machines.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as InlineCardNotifications from "../orchestration-v2/InlineCardNotifications.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export type ProviderSignInRequestResult =
  | { readonly _tag: "Posted"; readonly request: OrchestrationV2ProviderSignInRequest }
  | { readonly _tag: "AlreadySignedIn"; readonly machineName: string }
  /** No thread to post in; the caller runs the flow itself. */
  | { readonly _tag: "NoThread" };

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The machine a request targets and its provider entry, as `list` reports them. */
export const resolveSignInTarget = (
  list: MachineListResult,
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly targetEnvironmentId?: EnvironmentId | undefined;
  },
) => {
  const machine =
    input.targetEnvironmentId === undefined
      ? list.machines.find((candidate) => candidate.relation === "this")
      : list.machines.find((candidate) => candidate.environmentId === input.targetEnvironmentId);
  const provider = machine?.providers.find((entry) => entry.instanceId === input.instanceId);
  return { machine, provider };
};

/** Pending sign-in cards whose machine now reports the provider signed in. */
export const signedInCards = <
  T extends { readonly providerSignIn?: OrchestrationV2ProviderSignInRequest | undefined },
>(
  cards: ReadonlyArray<T>,
  list: MachineListResult,
): ReadonlyArray<T & { readonly providerSignIn: OrchestrationV2ProviderSignInRequest }> =>
  cards.filter(
    (card): card is T & { readonly providerSignIn: OrchestrationV2ProviderSignInRequest } =>
      card.providerSignIn !== undefined &&
      resolveSignInTarget(list, card.providerSignIn).provider?.auth === "authenticated",
  );

export class ProviderSignInRequests extends Context.Service<
  ProviderSignInRequests,
  {
    /** Posts the inline card in the calling thread, or says why none is needed. */
    readonly request: (
      scope: McpInvocationScope,
      input: {
        readonly instanceId: ProviderInstanceId;
        readonly targetEnvironmentId?: EnvironmentId | undefined;
      },
    ) => Effect.Effect<ProviderSignInRequestResult, OrchestratorMcpFailure>;
  }
>()("cogenly-server/provider/ProviderSignInRequests") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const machines = yield* Machines.Machines;
  const cards = yield* InlineCardNotifications.optional;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;

  const pendingCards = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) =>
          records.thread.deletedAt !== null || records.thread.archivedAt !== null
            ? []
            : records.turnItems.flatMap((item) =>
                item.type === "secret_request" &&
                item.secretStatus === "pending" &&
                item.providerSignIn !== undefined &&
                item.runId !== null &&
                item.nodeId !== null
                  ? [{ ...item, runId: item.runId, nodeId: item.nodeId }]
                  : [],
              ),
        ),
      );

  /** A sign-in can finish after the agent's turn, or after a server restart. */
  const completeCards = (list: MachineListResult) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        thread_id: string;
      }>`SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type = 'secret_request' AND json_extract(payload_json, '$.secretStatus') = 'pending' AND json_type(payload_json, '$.providerSignIn') = 'object'`;
      for (const row of rows) {
        const threadId = ThreadId.make(row.thread_id);
        for (const card of signedInCards(yield* pendingCards(threadId), list)) {
          const target = card.providerSignIn;
          yield* threads.dispatch({
            type: "secret_request.record",
            commandId: CommandId.make(`${card.id}:saved`),
            threadId,
            runId: card.runId,
            nodeId: card.nodeId,
            turnItemId: card.id,
            label: card.label,
            reason: card.reason,
            providerSignIn: target,
            secretStatus: "saved",
          });
          yield* cards.answered({
            threadId,
            key: `provider-sign-in:${card.id}`,
            summary: `${target.providerName} is signed in on ${target.machineName}`,
          });
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not complete an inline provider sign-in", {
          errorTag: error._tag,
        }),
      ),
    );

  yield* machines.subscribe.pipe(
    Stream.runForEach(completeCards),
    Effect.catch((error) =>
      Effect.logWarning("Provider sign-in cards stopped following machines", {
        errorTag: error._tag,
      }),
    ),
    Effect.forkScoped,
  );

  const request: ProviderSignInRequests["Service"]["request"] = (scope, input) =>
    Effect.gen(function* () {
      if (scope.thread === undefined) return { _tag: "NoThread" } as const;
      const caller = scope.thread;
      const list = yield* machines.list.pipe(
        Effect.mapError(() => invalid("The machine list could not be read. Try again.")),
      );
      const { machine, provider } = resolveSignInTarget(list, input);
      if (machine === undefined)
        return yield* invalid(
          "No paired machine has that targetEnvironmentId. machines_list shows them.",
        );
      if (provider === undefined)
        return yield* invalid(
          `${machine.name} has no provider ${input.instanceId}. machines_list shows each machine's providers.`,
        );
      if (provider.auth === "authenticated")
        return { _tag: "AlreadySignedIn", machineName: machine.name } as const;
      if (provider.canAuthenticate === false)
        return yield* invalid(
          `${provider.displayName} can't sign in from Cogenly. The user signs in on ${machine.name} itself.`,
        );
      if (!machine.online)
        return yield* invalid(`${machine.name} is offline. Sign-in needs it connected.`);
      const providerSignIn: OrchestrationV2ProviderSignInRequest = {
        instanceId: input.instanceId,
        ...(input.targetEnvironmentId === undefined
          ? {}
          : { targetEnvironmentId: input.targetEnvironmentId }),
        providerName: provider.displayName,
        machineName: machine.name,
      };
      // One open card per provider and machine; asking again points at it.
      const existing = (yield* pendingCards(caller.threadId)).find(
        (card) =>
          card.providerSignIn?.instanceId === input.instanceId &&
          card.providerSignIn.targetEnvironmentId === input.targetEnvironmentId,
      );
      if (existing !== undefined) return { _tag: "Posted", request: providerSignIn } as const;
      const records = yield* threads.getThreadRecords(caller.threadId, ["runs"]);
      const run = records.runs.find(
        (candidate) =>
          !Threads.isTerminalRunStatus(candidate.status) &&
          candidate.providerInstanceId === caller.providerInstanceId,
      );
      if (!run?.rootNodeId) return yield* invalid("This thread has no active turn to ask in.");
      const turnItemId = TurnItemId.make(
        `turn-item:provider-sign-in:${yield* crypto.randomUUIDv4()}`,
      );
      yield* threads.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`${turnItemId}:pending`),
        threadId: caller.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        turnItemId,
        label: `Sign in to ${provider.displayName} on ${machine.name}`,
        reason: "Finish signing in here. The agent continues once it is signed in.",
        providerSignIn,
        secretStatus: "pending",
      });
      return { _tag: "Posted", request: providerSignIn } as const;
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorMcpFailure"
          ? error
          : invalid("The sign-in card could not be posted. Try again."),
      ),
      Effect.withSpan("ProviderSignInRequests.request"),
    );

  return ProviderSignInRequests.of({ request });
});

export const layer = Layer.effect(ProviderSignInRequests, make);

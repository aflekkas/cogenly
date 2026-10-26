/**
 * LoginRequests - sign-in details an agent asks the user for (request_login).
 *
 * The answer goes straight into the vault as a login allowed on the card's
 * site; orchestration records only which item it was saved to. The agent
 * then signs in with vault_fill, so the values never reach the transcript,
 * projections, events or model context.
 *
 * A login the user chose not to keep is saved machine-only and removed once
 * the thread has no active work.
 *
 * @module LoginRequests
 */
import {
  CommandId,
  SecretRequestError,
  VaultItemId,
  type LoginRequestAnswerInput,
  type OrchestrationV2LoginRequest,
  type ThreadId,
} from "@cogenly/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- store names hash the item id.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as InlineCardNotifications from "../orchestration-v2/InlineCardNotifications.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Vault from "../vault/Vault.ts";
import { normalizeHost } from "../vault/VaultPolicy.ts";

const TEMPORARY_PREFIX = "login-request-temporary-";
const TEMPORARY_NAME_PATTERN = /^(login-request-temporary-[0-9a-f]{32})\.bin$/;
const temporaryName = (itemId: string) =>
  `${TEMPORARY_PREFIX}${NodeCrypto.createHash("sha256").update(itemId).digest("hex").slice(0, 32)}`;

/** A login kept only for the run that asked; no secret, just what to remove and when. */
const TemporaryLogin = Schema.fromJsonString(
  Schema.Struct({ itemId: Schema.String, threadId: Schema.String, runId: Schema.String }),
);
const encodeTemporary = Schema.encodeSync(TemporaryLogin);
const decodeTemporary = Schema.decodeUnknownOption(TemporaryLogin);

/** The item name a new login gets: the site's name, else its host. */
export const loginItemName = (login: OrchestrationV2LoginRequest): string =>
  login.updateItemName ?? login.siteName ?? (normalizeHost(login.origin) || login.origin);

/**
 * The secret fields an answer fills, limited to what the card asked for. The
 * username is trimmed; a password keeps its spaces but must not be only space.
 */
export const loginSecretFields = (
  fields: OrchestrationV2LoginRequest["fields"],
  answer: Extract<LoginRequestAnswerInput["answer"], { readonly type: "save" }>,
) => {
  const asked = new Set(fields);
  const present = (value: string | undefined) =>
    value !== undefined && value.trim().length > 0 ? value : undefined;
  const username = asked.has("username") ? present(answer.username?.trim()) : undefined;
  const password = asked.has("password") ? present(answer.password) : undefined;
  const totpSecret = asked.has("totp")
    ? present(answer.totpSecret?.replace(/\s+/g, ""))
    : undefined;
  const value = asked.has("note") ? present(answer.note) : undefined;
  return {
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(totpSecret === undefined ? {} : { totpSecret }),
    ...(value === undefined ? {} : { value }),
  };
};

export class LoginRequests extends Context.Service<
  LoginRequests,
  {
    /** Answers a pending sign-in card: save puts the login in the vault, decline closes it. */
    readonly answer: (input: LoginRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
  }
>()("cogenly-server/secrets/LoginRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const notifications = yield* InlineCardNotifications.optional;
  const vault = yield* Vault.Vault;
  const agents = yield* AgentStore.AgentStore;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;

  const loadCard = (threadId: ThreadId, turnItemId: string) =>
    threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => ({
          records,
          item: records.turnItems.find((candidate) => candidate.id === turnItemId),
        })),
        Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })),
      );

  /** Removes an item this answer created; logged, since the login stays in the vault otherwise. */
  const removeItem = (itemId: string) =>
    vault.delete({ id: VaultItemId.make(itemId) }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove an unused login request item", {
          reason: error.reason,
        }),
      ),
    );

  const answerLock = yield* Semaphore.make(1);
  const answer: LoginRequests["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "login_request.answer": input.answer.type,
      });
      const { item } = yield* loadCard(input.threadId, input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      const login = item.login;
      if (login === undefined) return yield* new SecretRequestError({ reason: "not_a_login" });
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      const runId = item.runId;
      const nodeId = item.nodeId;
      const record = (secretStatus: "saved" | "declined", recorded: OrchestrationV2LoginRequest) =>
        threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: CommandId.make(`login-request:${item.id}:${secretStatus}`),
            threadId: input.threadId,
            runId,
            nodeId,
            turnItemId: item.id,
            label: item.label,
            reason: item.reason,
            secretStatus,
            login: recorded,
          })
          .pipe(
            Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          );

      const notify = (summary: string) =>
        notifications.answered({
          threadId: input.threadId,
          key: `login:${input.threadId}:${item.id}`,
          summary,
        });
      if (input.answer.type === "decline") {
        yield* record("declined", login);
        return yield* notify(`Sign-in declined: ${login.siteName ?? login.origin}`);
      }

      const secretFields = loginSecretFields(login.fields, input.answer);
      if (Object.keys(secretFields).length === 0) {
        return yield* new SecretRequestError({ reason: "login_empty" });
      }
      const keep = input.answer.keep || login.updateItemId !== undefined;
      const agent = yield* agents.forThread(input.threadId).pipe(Effect.orElseSucceed(() => null));
      const saved = yield* vault
        .saveLogin({
          name: loginItemName(login),
          domain: login.origin,
          secretFields,
          ...(login.updateItemId === undefined
            ? {}
            : { updateItemId: VaultItemId.make(login.updateItemId) }),
          temporary: !keep,
          threadId: input.threadId,
          agentId: agent?.id ?? null,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "vault_failed", cause })),
        );
      // Only an item this answer created is undone; an update already replaced
      // the stored secrets, and the user asked for that.
      const undo = saved.updated ? Effect.void : removeItem(saved.item.id);
      if (!keep) {
        yield* store
          .set(
            temporaryName(saved.item.id),
            new TextEncoder().encode(
              encodeTemporary({ itemId: saved.item.id, threadId: input.threadId, runId }),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
            Effect.tapError(() => undo),
          );
      }
      yield* record("saved", {
        ...login,
        savedItemId: saved.item.id,
        savedItemName: saved.item.name,
        kept: keep,
      }).pipe(Effect.tapError(() => undo));
      yield* notify(
        `Login saved: ${saved.item.name}. Use vault_fill to sign in to ${login.origin}`,
      );
      // A concurrent explicit cancellation must not leave an unused login behind.
      const after = yield* loadCard(input.threadId, item.id).pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
      );
      if (after.item?.type === "secret_request" && after.item.secretStatus !== "saved") {
        yield* undo;
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    }).pipe(answerLock.withPermits(1), Effect.withSpan("LoginRequests.answer"));

  /** Removes temporary logins once the thread has finished using them. */
  const sweepTemporary = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = TEMPORARY_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const entry = Option.flatMap(stored, (bytes) =>
        decodeTemporary(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(entry)) {
        const runs = yield* threadManagement
          .getThreadRecords(entry.value.threadId as ThreadId, ["runs"])
          .pipe(
            Effect.map((records) => records.runs),
            // A thread that is gone has no run left to use the login.
            Effect.orElseSucceed(() => []),
          );
        if (runs.some((run) => !ThreadManagementService.isTerminalRunStatus(run.status))) continue;
        yield* removeItem(entry.value.itemId);
      }
      yield* store.remove(name).pipe(Effect.ignore);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "login_request.temporary_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep temporary logins", cause)),
    Effect.withSpan("LoginRequests.sweepTemporary"),
  );
  yield* sweepTemporary.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped);

  return LoginRequests.of({ answer });
});

export const layer = Layer.effect(LoginRequests, make);

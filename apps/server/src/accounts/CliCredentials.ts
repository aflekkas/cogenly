import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import { processOutputRedactor } from "../vault/VaultRedactor.ts";
import { AccountError, AccountId, CredentialId, AccountMachineStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Vault from "../vault/Vault.ts";
import * as AccountAccess from "./AccountAccess.ts";
import { cliAdapter, verificationState } from "./CliAdapters.ts";

export interface CredentialDelivery {
  readonly redactOutput?: (chunk: string, final?: boolean) => string;
  readonly env: Record<string, string>;
  readonly complete: (outcome: "delivered" | "launch_failed") => Effect.Effect<void, AccountError>;
}
export class CliCredentials extends Context.Service<
  CliCredentials,
  {
    readonly launch: (
      input: AccountAccess.AccountCallerInput,
      terminalId: string,
    ) => Effect.Effect<CredentialDelivery, AccountError>;
    readonly verify: (
      input: AccountAccess.AccountCallerInput,
      accountId: AccountId,
      credentialId: CredentialId,
    ) => Effect.Effect<AccountMachineStatus, AccountError>;
  }
>()("cogenly-server/accounts/CliCredentials") {}
const wrap = (cause: unknown) =>
  Schema.is(AccountError)(cause) ? cause : new AccountError({ reason: "unavailable", cause });
const make = Effect.gen(function* () {
  const access = yield* AccountAccess.AccountAccess;
  const vault = yield* Vault.Vault;
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const resolve = Effect.fnUntraced(function* (
    input: AccountAccess.AccountCallerInput,
    terminalId: string,
    method: "environment" | "verification",
    selectedId?: CredentialId,
  ) {
    const authorized = yield* access.forLaunch(input, terminalId, method, selectedId);
    const env: Record<string, string> = {};
    for (const item of authorized.credentials.filter(
      (item) => selectedId === undefined || item.credential.id === selectedId,
    )) {
      yield* Effect.gen(function* () {
        const adapter = cliAdapter(item.account.serviceId);
        if (!adapter || env[adapter.tokenVariable] !== undefined)
          return yield* new AccountError({ reason: "invalid_input" });
        const result = yield* vault.use({
          itemId: item.credential.vaultItemId,
          scopeProjectId: authorized.caller.scopeProjectId,
          caller: { kind: "server" },
          field: "value",
          expectedRevision: item.revision,
          threadId: input.threadId,
          action: "process_resolve",
        });
        if (result.status !== "allowed" || result.value.length < 6)
          return yield* new AccountError({ reason: "unavailable" });
        yield* vault.registerProcessSecrets([result.value]);
        env[adapter.tokenVariable] = result.value;
        // Cloudflare's optional account selector stays encrypted with the token.
        if (item.account.serviceId === "cloudflare" && result.item.fields.includes("username")) {
          const account = yield* vault.use({
            itemId: item.credential.vaultItemId,
            caller: { kind: "server" },
            field: "username",
            expectedRevision: item.revision,
            threadId: input.threadId,
            action: "process_resolve",
          });
          if (account.status !== "allowed")
            return yield* new AccountError({ reason: "unavailable" });
          yield* vault.registerProcessSecrets([account.value]);
          env.CLOUDFLARE_ACCOUNT_ID = account.value;
        }
        yield* access.audit({
          caller: authorized.caller,
          credential: item,
          terminalId,
          outcome: "prepared",
          method,
        });
      }).pipe(
        Effect.mapError(wrap),
        Effect.tapError((error) =>
          access.audit({
            caller: authorized.caller,
            credential: item,
            terminalId,
            method,
            outcome: error.reason,
          }),
        ),
      );
    }
    return { ...authorized, env };
  }, Effect.mapError(wrap));
  return CliCredentials.of({
    launch: Effect.fnUntraced(function* (input, terminalId) {
      const resolved = yield* resolve(input, terminalId, "environment");
      return {
        env: resolved.env,
        redactOutput: processOutputRedactor(
          Object.values(resolved.env).flatMap((value) => [
            value,
            Buffer.from(value).toString("base64"),
            encodeURIComponent(value),
            JSON.stringify(value).slice(1, -1),
          ]),
        ),
        complete: (outcome: "delivered" | "launch_failed") =>
          Effect.forEach(
            resolved.credentials,
            (credential) =>
              access.audit({ caller: resolved.caller, credential, terminalId, outcome }),
            { discard: true },
          ),
      };
    }, Effect.mapError(wrap)),
    verify: Effect.fnUntraced(function* (input, accountId, credentialId) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const authorized = yield* access.forLaunch(
            input,
            `verify:${credentialId}`,
            "verification",
            credentialId,
          );
          const selected = authorized.credentials.find(
            (c) => c.account.id === accountId && c.credential.id === credentialId,
          );
          if (!selected) return yield* new AccountError({ reason: "denied" });
          const adapter = cliAdapter(selected.account.serviceId);
          if (!adapter) return yield* new AccountError({ reason: "invalid_input" });
          const resolved = yield* resolve(
            input,
            `verify:${credentialId}`,
            "verification",
            credentialId,
          );
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-account-check-" });
          // An empty home/config and a replacement environment keep verification out
          // of native OAuth stores and exclude ambient tokens. Output never escapes.
          const path = yield* HostProcess.Environment.pipe(Effect.map((env) => env.PATH));
          const env = {
            PATH: path ?? "/usr/bin:/bin",
            HOME: directory,
            USERPROFILE: directory,
            XDG_CONFIG_HOME: directory,
            GH_CONFIG_DIR: directory,
            WRANGLER_HOME: directory,
            CI: "true",
            GH_PROMPT_DISABLED: "1",
            [adapter.tokenVariable]: resolved.env[adapter.tokenVariable]!,
            ...(selected.account.serviceId === "cloudflare" && resolved.env.CLOUDFLARE_ACCOUNT_ID
              ? { CLOUDFLARE_ACCOUNT_ID: resolved.env.CLOUDFLARE_ACCOUNT_ID }
              : {}),
          };
          const result = yield* runner
            .run({
              command: adapter.command,
              args: adapter.args,
              cwd: directory,
              env,
              extendEnv: false,
              timeout: "15 seconds",
              timeoutBehavior: "timedOutResult",
              maxOutputBytes: 16_384,
              outputMode: "truncate",
            })
            .pipe(Effect.result);
          const state =
            result._tag === "Failure"
              ? result.failure._tag === "ProcessSpawnError" &&
                isCommandMissingCause(result.failure.cause)
                ? "cli_missing"
                : "network_failure"
              : verificationState(result.success);
          const status: AccountMachineStatus = {
            accountId,
            credentialId,
            environmentId: yield* identity.getEnvironmentId,
            credentialRevision: String(selected.revision),
            state,
            checkedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            reason: state === "verified" ? "authentication_only" : "verification_failed",
          };
          yield* sql`INSERT INTO account_machine_status(credential_id, environment_id, payload_json) VALUES (${credentialId}, ${status.environmentId}, ${yield* Schema.encodeEffect(Schema.fromJsonString(AccountMachineStatus))(status)}) ON CONFLICT(credential_id, environment_id) DO UPDATE SET payload_json = excluded.payload_json`;
          yield* access.audit({
            caller: authorized.caller,
            credential: selected,
            terminalId: `verify:${credentialId}`,
            outcome: state,
            method: "verification",
          });
          return status;
        }),
      );
    }, Effect.mapError(wrap)),
  });
});
export const layer = Layer.effect(CliCredentials, make);

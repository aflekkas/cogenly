import {
  type ServerSettings,
  type ProviderInstanceConfig,
  ProviderDriverKind,
} from "@cogenly/contracts";
import { decodeJwt } from "jose";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Hex from "effect/encoding/Hex";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";

const Config = Schema.Struct({
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  syncAccountIdentity: Schema.optionalKey(Schema.String),
});
const decodeConfig = Schema.decodeUnknownOption(Config);
const ClaudeAccount = Schema.fromJsonString(
  Schema.Struct({
    oauthAccount: Schema.Struct({
      accountUuid: Schema.NonEmptyString,
      organizationUuid: Schema.NonEmptyString,
    }),
  }),
);
const CodexAccount = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({ account_id: Schema.NonEmptyString, id_token: Schema.NonEmptyString }),
  }),
);
const decodeClaudeAccount = Schema.decodeUnknownOption(ClaudeAccount);
const decodeCodexAccount = Schema.decodeUnknownOption(CodexAccount);

export interface ProviderAccountIdentity {
  readonly identity: string;
  readonly homePath: string;
  readonly driver: string;
}

/** Read identity metadata only. Never access Claude's Keychain or export either CLI's tokens. */
export const readProviderAccountIdentities = Effect.fn("readProviderAccountIdentities")(function* (
  settings: ServerSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const entries: Record<string, ProviderInstanceConfig> = {
    codex: { driver: ProviderDriverKind.make("codex") },
    claudeAgent: { driver: ProviderDriverKind.make("claudeAgent") },
    ...settings.providerInstances,
  };
  const identities = new Map<string, ProviderAccountIdentity>();
  for (const [id, instance] of Object.entries(entries)) {
    if (instance.driver !== "codex" && instance.driver !== "claudeAgent") continue;
    const decoded = decodeConfig(instance.config ?? {});
    const config = Option.isSome(decoded) ? decoded.value : {};
    const custom =
      instance.driver === "codex"
        ? config.shadowHomePath?.trim() || config.homePath?.trim()
        : config.homePath?.trim();
    const directory = custom
      ? expandHomePath(custom, home)
      : path.join(home, instance.driver === "codex" ? ".codex" : ".claude");
    const file =
      instance.driver === "codex"
        ? path.join(directory, "auth.json")
        : custom
          ? path.join(directory, ".claude.json")
          : path.join(home, ".claude.json");
    const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    let account: string | undefined;
    if (instance.driver === "claudeAgent") {
      const value = decodeClaudeAccount(raw);
      if (Option.isSome(value))
        account = `${value.value.oauthAccount.accountUuid}\u0000${value.value.oauthAccount.organizationUuid}`;
    } else {
      const value = decodeCodexAccount(raw);
      if (Option.isSome(value)) {
        const claims = yield* Effect.try(() => decodeJwt(value.value.tokens.id_token)).pipe(
          Effect.option,
        );
        const subject = Option.isSome(claims) ? claims.value.sub : undefined;
        if (subject) account = `${subject}\u0000${value.value.tokens.account_id}`;
      }
    }
    if (!account) continue;
    const identity = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${instance.driver}:${account}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    identities.set(id, { identity, homePath: custom ?? "", driver: instance.driver });
  }
  return identities;
});

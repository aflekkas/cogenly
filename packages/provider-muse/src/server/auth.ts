/**
 * The Muse Code login as Cogenly reports it: the account email from Muse's
 * credential file. MSP has no auth request, so this is the only account
 * identity available. Limits views key subscription accounts by email, which
 * is what lets two environments on one Muse login show as one account.
 *
 * @module provider-muse/server/auth
 */
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MuseCredentialFile = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Struct({
      meta: Schema.Struct({ user_email: Schema.optional(Schema.String) }),
    }),
  }),
);
const decodeCredentialFile = Schema.decodeUnknownOption(MuseCredentialFile);

/** Where the `muse` launcher looks for its login, in the same order. */
export const museCredentialPath = Effect.fn("museCredentialPath")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const override = environment.MUSE_AUTH_PATH?.trim();
  if (override) return override;
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  if (configHome) return path.join(configHome, "muse", "auth.json");
  return path.join(yield* HostProcess.HomeDirectory, ".config", "muse", "auth.json");
});

/** The signed-in account's email, or undefined when Muse has no readable login. */
export const readMuseAccountEmail = Effect.fn("readMuseAccountEmail")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem
    .readFileString(yield* museCredentialPath(environment))
    .pipe(Effect.orElseSucceed(() => ""));
  const email = decodeCredentialFile(raw).pipe(
    Option.flatMap((file) => Option.fromNullishOr(file.providers.meta.user_email?.trim())),
    Option.filter((value) => value.length > 0),
  );
  return Option.getOrUndefined(email);
});

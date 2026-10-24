/**
 * The Grok Build login as Cogenly reports it: the account email and cached
 * token from the CLI's `auth.json`, read-only. Cogenly never writes or
 * refreshes the file; the CLI owns it. Limits views key subscription
 * accounts by email, so two environments on one login show as one account.
 *
 * @module provider-grok/server/auth
 */
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseGrokAuthFile, type GrokCachedToken } from "./billing.ts";

/** Where the CLI keeps its login: `$GROK_HOME/auth.json`, else `~/.grok/auth.json`. */
export const grokAuthPath = Effect.fn("grokAuthPath")(function* (environment: NodeJS.ProcessEnv) {
  const path = yield* Path.Path;
  const home = environment.GROK_HOME?.trim();
  if (home) return path.join(home, "auth.json");
  return path.join(yield* HostProcess.HomeDirectory, ".grok", "auth.json");
});

/** The cached CLI token, or undefined when Grok has no readable login. */
export const readGrokCachedToken = Effect.fn("readGrokCachedToken")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem
    .readFileString(yield* grokAuthPath(environment))
    .pipe(Effect.orElseSucceed(() => ""));
  const token: GrokCachedToken | undefined = raw ? parseGrokAuthFile(raw) : undefined;
  return token;
});

/** The signed-in account's email, when the CLI's login names one. */
export const readGrokAccountEmail = Effect.fn("readGrokAccountEmail")(function* (
  environment: NodeJS.ProcessEnv,
) {
  return (yield* readGrokCachedToken(environment))?.email;
});

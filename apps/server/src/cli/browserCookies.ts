import {
  AuthPreviewOperateScope,
  BrowserCookieImportError,
  BrowserCookieImportInput,
  BrowserImportSourceId,
  WS_METHODS,
} from "@cogenly/contracts";
import * as LocalBrowserCookies from "@cogenly/shared/browserCookies/LocalBrowserCookies";
import { isLoopbackHost } from "@cogenly/shared/preview";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";
import { liveWebSocketUrl, makeLiveRpcClient } from "./liveServer.ts";

const decodeImportInput = Schema.decodeUnknownEffect(BrowserCookieImportInput);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Only connect to the server recorded in this local Cogenly home; never relay raw cookies. */
const importLive = Effect.fnUntraced(function* (
  baseDir: Option.Option<string>,
  input: BrowserCookieImportInput,
) {
  const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel);
  const recorded = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(recorded))
    return yield* new BrowserCookieImportError({
      message:
        "Start Cogenly on this machine before importing. --list and --dry-run also work while it is stopped.",
    });
  const origin = recorded.value.origin;
  if (!isLoopbackHost(new URL(origin).hostname))
    return yield* new BrowserCookieImportError({
      message: "Cookie import must connect to Cogenly on this machine through a loopback address.",
    });
  const authContext = yield* Layer.build(
    EnvironmentAuth.layerRuntime.pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    ),
  );
  const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
  const session = yield* auth.issueSession({
    scopes: [AuthPreviewOperateScope],
    label: "cogenly browser import-cookies",
  });
  yield* Effect.addFinalizer(() => auth.revokeSession(session.sessionId).pipe(Effect.ignore));
  const url = yield* liveWebSocketUrl(origin, session.token).pipe(
    Effect.provideContext(authContext),
  );
  const client = yield* makeLiveRpcClient(url);
  return yield* client[WS_METHODS.browserImportCookies](input);
});

export const browserImportCookiesCommand = Command.make("import-cookies", {
  baseDir: baseDirFlag,
  from: Flag.Literals("from", BrowserImportSourceId.literals).pipe(Flag.optional),
  profile: Flag.String("profile").pipe(Flag.optional),
  to: Flag.String("to").pipe(Flag.withDefault("default")),
  domain: Flag.String("domain").pipe(Flag.optional),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  list: Flag.Boolean("list").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Copy local browser sign-ins into a Cogenly server-browser profile. Values never leave this machine or appear in output.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.list) {
        const reader = yield* LocalBrowserCookies.LocalBrowserCookies;
        const sources = yield* reader.listSources;
        return yield* Console.log(
          sources.length === 0
            ? "No browser cookie stores found on this machine."
            : yield* encodeJson(sources).pipe(Effect.orDie),
        );
      }
      const input = yield* decodeImportInput({
        ...(Option.isSome(flags.from) ? { sourceId: flags.from.value } : {}),
        ...(Option.isSome(flags.profile) ? { sourceProfileDirectory: flags.profile.value } : {}),
        targetProfileId: flags.to,
        dryRun: flags.dryRun,
        ...(Option.isSome(flags.domain)
          ? {
              domains: flags.domain.value
                .split(",")
                .map((value) => value.trim().replace(/^\./, "").toLowerCase()),
            }
          : {}),
      }).pipe(
        Effect.mapError(
          () =>
            new BrowserCookieImportError({
              message: "Use comma-separated domain names, and a valid source and target profile.",
            }),
        ),
      );
      const result = flags.dryRun
        ? yield* Effect.flatMap(LocalBrowserCookies.LocalBrowserCookies, (reader) =>
            reader.importCookies(input, async () => {}),
          )
        : yield* importLive(flags.baseDir, input);
      yield* Console.log(yield* encodeJson(result).pipe(Effect.orDie));
      if (result.reloadRequired)
        yield* Console.log(
          "Reload existing server-browser preview tabs on this profile to use the imported sign-ins.",
        );
    }).pipe(Effect.scoped, Effect.provide(LocalBrowserCookies.layer)),
  ),
);

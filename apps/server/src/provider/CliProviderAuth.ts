import * as NodeUtil from "node:util";
import { ProviderSetupError, type ProviderInstanceId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ProviderAuthFlow from "@cogenly/provider-core/server/providerAuthFlow";

/** Only public sign-in instructions leave the subprocess; native output never enters logs or state. */
export function cliLoginInteraction(driver: "codex" | "claudeAgent", output: string) {
  const clean = NodeUtil.stripVTControlCharacters(output);
  const urls = clean.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (
      driver === "codex" &&
      url.hostname === "auth.openai.com" &&
      url.pathname === "/codex/device"
    ) {
      const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
      if (code)
        return {
          type: "deviceCode" as const,
          id: "cli-login",
          url: `${url.origin}${url.pathname}`,
          userCode: code[0],
        };
    }
    if (
      driver === "claudeAgent" &&
      ["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) &&
      url.pathname === "/oauth/authorize" &&
      !["access_token", "refresh_token", "id_token"].some((key) => url.searchParams.has(key))
    ) {
      return { type: "browser" as const, id: "cli-login", url: url.href, requiresConsent: false };
    }
  }
  return undefined;
}

/** Each machine obtains its own grant. Never copy a rotating refresh token to another CLI. */
export const make = Effect.fn("CliProviderAuth.make")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: "codex" | "claudeAgent";
  readonly binaryPath: string;
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<unknown>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fail = () =>
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "login",
      detail: "The CLI could not finish sign-in. Start again.",
    });
  const env = {
    ...input.environment,
    BROWSER: "true",
    NO_COLOR: "1",
    ...(input.driver === "codex" ? { CODEX_HOME: input.homePath } : {}),
  };
  const command = (args: string[]) =>
    ChildProcess.make(input.binaryPath, args, {
      env,
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  return yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    credentialBinding: { owner: "provider", key: `${input.driver}:${input.homePath}` },
    methods: Effect.succeed([
      {
        id: "cli",
        name: "Sign in with the official CLI",
        type: "agent",
        description: "Complete this machine's sign-in in your browser.",
      },
    ]),
    defaultMethodId: "cli",
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        const stdin = yield* Queue.unbounded<Uint8Array>();
        const child = yield* spawner.spawn(
          command(input.driver === "codex" ? ["login", "--device-auth"] : ["auth", "login"]),
        );
        yield* Stream.fromQueue(stdin).pipe(Stream.run(child.stdin), Effect.forkScoped);
        let buffer = "";
        let published = false;
        yield* child.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              // Bound memory even if a CLI fails noisily. Do not publish raw terminal output.
              buffer = (buffer + chunk).slice(-32_768);
              const interaction = cliLoginInteraction(input.driver, buffer);
              if (published || !interaction) return;
              published = true;
              if (input.driver === "claudeAgent") {
                // The CLI's documented SSH fallback accepts the browser's one-time code on stdin.
                yield* context.setInteraction(
                  {
                    type: "credentials",
                    url: interaction.url,
                    id: "cli-code",
                    fields: [{ name: "code", label: "Code from the sign-in page", secret: true }],
                  },
                  (response) => {
                    if (
                      response.type !== "credentials" ||
                      !response.values.code?.trim() ||
                      /[\r\n]/.test(response.values.code)
                    )
                      return Effect.fail(fail());
                    return Queue.offer(
                      stdin,
                      new TextEncoder().encode(`${response.values.code.trim()}\n`),
                    ).pipe(Effect.asVoid);
                  },
                );
              } else {
                yield* context.setInteraction(interaction);
              }
            }),
          ),
        );
        const exitCode = yield* child.exitCode;
        if (exitCode !== 0) return yield* fail();
        yield* input.onChanged;
      }).pipe(Effect.mapError(() => fail())),
    logout: spawner
      .exitCode(command(input.driver === "codex" ? ["logout"] : ["auth", "logout"]))
      .pipe(
        Effect.flatMap((code) =>
          code === 0 ? input.onChanged.pipe(Effect.asVoid) : Effect.fail(fail()),
        ),
        Effect.mapError(() => fail()),
      ),
  });
});

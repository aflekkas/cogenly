import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as CliProviderAuth from "./CliProviderAuth.ts";

it("extracts only provider-owned public instructions from noisy CLI output", () => {
  expect(
    CliProviderAuth.cliLoginInteraction(
      "codex",
      "secret-token\nhttps://evil.example/oauth\nhttps://auth.openai.com/codex/device\nABCD-EFGHI\nrefresh_token=DO_NOT_SHOW",
    ),
  ).toEqual({
    type: "deviceCode",
    id: "cli-login",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGHI",
  });
  expect(
    CliProviderAuth.cliLoginInteraction(
      "codex",
      "https://auth.openai.com.evil.example/codex/device ABCD-EFGHI",
    ),
  ).toBeUndefined();
  expect(
    CliProviderAuth.cliLoginInteraction(
      "claudeAgent",
      "https://claude.ai/oauth/authorize?state=state\nrefreshToken=DO_NOT_SHOW",
    ),
  ).toEqual({
    type: "browser",
    id: "cli-login",
    url: "https://claude.ai/oauth/authorize?state=state",
    requiresConsent: false,
  });
});

const fixture = Effect.fn("fixture")(function* (script: string, driver: "codex" | "claudeAgent") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const binary = path.join(dir, "official-cli-fixture");
  yield* fs.writeFileString(binary, `#!${process.execPath}\n${script}`);
  yield* fs.chmod(binary, 0o700);
  let changes = 0;
  const auth = yield* CliProviderAuth.make({
    instanceId: ProviderInstanceId.make("fixture"),
    driver,
    binaryPath: binary,
    homePath: dir,
    environment: driver === "claudeAgent" ? { CLAUDE_CONFIG_DIR: dir } : {},
    onChanged: Effect.sync(() => {
      changes++;
    }),
  });
  const phase = (phase: string) =>
    auth.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { auth, phase, changes: () => changes, dir, fs, path };
});

it.live(
  "runs the target's official login with its own home and accepts the Claude browser code",
  () =>
    Effect.gen(function* () {
      const { auth, phase, changes, dir, fs, path } = yield* fixture(
        `
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'auth login') process.exit(2);
console.log('https://claude.ai/oauth/authorize?state=fixture');
process.stdin.once('data', (code) => {
  if (code.toString() !== 'one-time-code\\n') process.exit(3);
  fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/login-finished', 'independent-grant');
  process.exit(0);
});`,
        "claudeAgent",
      );
      const flow = yield* auth.start("owner", Effect.void, "cli");
      const waiting = yield* phase("waiting");
      expect(waiting.authorizationUrl).toBe("https://claude.ai/oauth/authorize?state=fixture");
      expect(waiting.interaction?.type).toBe("credentials");
      yield* auth.respond!("owner", {
        instanceId: ProviderInstanceId.make("fixture"),
        flowId: flow.flowId!,
        interactionId: "cli-code",
        response: { type: "credentials", values: { code: "one-time-code" } },
      });
      yield* phase("succeeded");
      expect(changes()).toBe(1);
      expect(yield* fs.readFileString(path.join(dir, "login-finished"))).toBe("independent-grant");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "never exposes native token errors and permits cancellation without copying credentials",
  () =>
    Effect.gen(function* () {
      const { auth, phase, changes } = yield* fixture(
        "console.error('refresh_token=DO_NOT_SHOW'); process.exit(1);",
        "codex",
      );
      yield* auth.start("owner", Effect.void, "cli");
      const failed = yield* phase("failed");
      expect(failed.message).toBe("The CLI could not finish sign-in. Start again.");
      expect(failed.interaction).toBeNull();
      expect(changes()).toBe(0);
      const pending = yield* fixture(
        "console.log('https://auth.openai.com/codex/device ABCD-EFGHI'); process.stdin.resume();",
        "codex",
      );
      const flow = yield* pending.auth.start("owner", Effect.void, "cli");
      yield* pending.phase("waiting");
      expect((yield* pending.auth.cancel("owner", flow.flowId!)).phase).toBe("cancelled");
      expect(pending.changes()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

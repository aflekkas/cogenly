import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
  const output = yield* Deferred.make<void>();
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
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...spawner,
      spawn: (command) =>
        spawner.spawn(command).pipe(
          Effect.tap((child) => Deferred.succeed(spawned, child)),
          Effect.map((child) => ({
            ...child,
            all: child.all.pipe(Stream.tap(() => Deferred.succeed(output, undefined))),
          })),
        ),
    }),
  );
  const phase = (phase: string) =>
    auth.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { auth, phase, changes: () => changes, dir, fs, path, spawned, output };
});

it.live(
  "runs the target's official login with its own home and accepts the Claude browser code",
  () =>
    Effect.gen(function* () {
      const { auth, phase, changes, dir, fs, path } = yield* fixture(
        `
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'auth login') process.exit(2);
console.log('Opening browser to sign in…');
console.log("If the browser didn’t open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?state=fixture\x07https://claude.com/cai/oauth/authorize?state=fixture\x1b]8;;\x07");
process.stdout.write('Paste code here if prompted > ');
process.stdin.once('data', (code) => {
  if (code.toString() !== 'one-time-code\\n') process.exit(3);
  fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/login-finished', 'independent-grant');
  process.exit(0);
});`,
        "claudeAgent",
      );
      const flow = yield* auth.start("owner", Effect.void, "cli");
      const waiting = yield* phase("waiting");
      expect(waiting.authorizationUrl).toBe("https://claude.com/cai/oauth/authorize?state=fixture");
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

it("accepts Codex's current device-code format only after the complete code arrives", () => {
  expect(
    CliProviderAuth.cliLoginInteraction(
      "codex",
      "https://auth.openai.com/codex/device\nABCD-EFGH\n",
    ),
  ).toEqual({
    type: "deviceCode",
    id: "cli-login",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
  expect(
    CliProviderAuth.cliLoginInteraction("codex", "https://auth.openai.com/codex/device\nABCD-EFGH"),
  ).toBeUndefined();
});

it("parses Claude's current OSC hyperlink and ignores incomplete or untrusted URLs", () => {
  const url =
    "https://claude.com/cai/oauth/authorize?code=true&state=fixture&code_challenge=challenge";
  const output = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
  expect(CliProviderAuth.cliLoginInteraction("claudeAgent", output)).toEqual({
    type: "browser",
    id: "cli-login",
    url,
    requiresConsent: false,
  });
  for (const invalid of [
    url,
    "https://claude.com.evil.example/cai/oauth/authorize?state=fixture\n",
    "https://claude.com/cai/oauth/authorize?access_token=DO_NOT_SHOW\n",
    "https://claude.com/other/path?state=fixture\n",
  ])
    expect(CliProviderAuth.cliLoginInteraction("claudeAgent", invalid)).toBeUndefined();
});

it.effect(
  "times out missing instructions and stops its spawned child before reporting failure",
  () =>
    Effect.gen(function* () {
      const { auth, phase, spawned, output, changes } = yield* fixture(
        "process.on('SIGTERM', () => {}); console.log('Opening browser to sign in…'); process.stdin.resume();",
        "claudeAgent",
      );
      yield* auth.start("owner", Effect.void, "cli");
      const child = yield* Deferred.await(spawned);
      yield* Deferred.await(output);
      expect(yield* child.isRunning).toBe(true);
      yield* TestClock.adjust(30_001);
      const failed = yield* phase("failed");
      expect(failed.message).toBe(
        "The CLI did not provide a sign-in link within 30 seconds. Start again.",
      );
      expect(failed.authorizationUrl).toBeNull();
      expect(failed.interaction).toBeNull();
      expect(yield* child.isRunning).toBe(false);
      expect(changes()).toBe(0);
      expect((yield* auth.start("owner", Effect.void, "cli")).phase).toBe("starting");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps waiting after startup instructions arrive and cancels from another client", () =>
  Effect.gen(function* () {
    const { auth, phase, spawned } = yield* fixture(
      "console.log('https://claude.com/cai/oauth/authorize?state=fixture'); process.stdin.resume();",
      "claudeAgent",
    );
    yield* auth.start("owner", Effect.void, "cli");
    const child = yield* Deferred.await(spawned);
    yield* phase("waiting");
    yield* TestClock.adjust(30_001);
    const hidden = yield* auth
      .subscribe("other")
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    expect(hidden.phase).toBe("waiting");
    expect(hidden.flowId).toBeNull();
    expect((yield* auth.cancel("other", null)).phase).toBe("cancelled");
    expect(yield* child.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

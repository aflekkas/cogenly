import { ServerProviderModel } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";

import { GrokSettings } from "../settings.ts";
import { createGrokAcpHost, createGrokAcpHostEffect, makeGrokEnvironment } from "./acp.ts";
import { readGrokAccountEmail } from "./auth.ts";
import { parseGrokVersion } from "./maintenance.ts";
import { grokModelCapabilities, grokModelsFromSession } from "./modelCatalog.ts";
import { parseGrokSessionResult } from "./protocol.ts";
import { readGrokUsageLimits } from "./usageLimits.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportedRuntimeModes: ["full-access"],
} as const;

const FALLBACK_CAPABILITIES = grokModelCapabilities();

export const makePendingGrokProvider = Effect.fn("makePendingGrokProvider")(function* (
  settings: GrokSettings,
) {
  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings([], settings.customModels, FALLBACK_CAPABILITIES),
    slashCommands: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Grok Build CLI availability..."
        : "Grok is disabled in Cogenly settings.",
    },
  });
});

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  settings: GrokSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  createHost: typeof createGrokAcpHost = createGrokAcpHost,
  usageLimitsCachePath?: string,
) {
  if (!settings.enabled) return yield* makePendingGrokProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const grokEnvironment = environment ?? makeGrokEnvironment();
  const snapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel> = []) =>
    buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(models, settings.customModels, FALLBACK_CAPABILITIES),
      // ACP has no compaction request, so Grok offers no /compact.
      slashCommands: [],
      probe,
    });

  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: grokEnvironment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: grokEnvironment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Grok Build CLI (`grok`) was not found. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash` and run `grok login` on this Cogenly server host."
        : "Failed to execute the Grok Build CLI. Check its binary path on this Cogenly server host.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Grok Build CLI version check timed out.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGrokVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Grok Build CLI is installed but failed to run.",
    });
  }

  // One short ACP session: initialize and authenticate prove the login, the
  // session lists the models, and the same host answers the billing read.
  const probe = yield* Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      createGrokAcpHostEffect(
        {
          binaryPath: settings.binaryPath,
          environment: grokEnvironment,
          ...(cwd ? { cwd } : {}),
          startupTimeoutMs: 10_000,
        },
        createHost,
      ),
      (host) => Effect.promise(() => host.close()),
      { interruptible: true },
    );
    // `initialize` already lists the models; a session is only needed when it does not.
    const modelState = host.initializeResult.modelState.models.length
      ? host.initializeResult.modelState
      : parseGrokSessionResult(
          yield* Effect.tryPromise(() =>
            host.connection.request("session/new", { cwd: cwd ?? process.cwd(), mcpServers: [] }),
          ),
        );
    const usageLimits = yield* readGrokUsageLimits({
      host,
      environment: grokEnvironment,
      cliVersion: version,
      cachePath: usageLimitsCachePath,
    });
    return { models: grokModelsFromSession(modelState), usageLimits, account: host.account };
  }).pipe(Effect.scoped, Effect.timeoutOption(20_000), Effect.result);
  if (Result.isFailure(probe) || Option.isNone(probe.success)) {
    const detail = Result.isFailure(probe)
      ? probe.failure instanceof Error
        ? probe.failure.message
        : String(probe.failure)
      : "timed out";
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: /signed in|login|auth/i.test(detail) ? "unauthenticated" : "unknown" },
      message: `Grok could not start a session (${detail}). Run \`grok login\` on this Cogenly server host.`,
    });
  }
  const { account, models, usageLimits } = probe.success.value;
  // `authenticate` names the account; the CLI's auth.json is the fallback.
  const email = account.email ?? (yield* readGrokAccountEmail(grokEnvironment));
  return {
    ...snapshot(
      {
        installed: true,
        version,
        status: "ready",
        auth: {
          status: "authenticated",
          ...(email ? { email } : {}),
          ...(account.subscriptionTier ? { label: `Grok ${account.subscriptionTier}` } : {}),
        },
      },
      models,
    ),
    usageLimits,
  };
});

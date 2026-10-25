// @effect-diagnostics nodeBuiltinImport:off -- read-only SDK policy probe with an isolated provider environment.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseCliArgs } from "@cogenly/shared/cliArgs";
import { compareSemverVersions, parseSemver } from "@cogenly/shared/semver";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/** Unknown/older CLIs must never receive the boolean form: they reject it. */
export function claudeAttributionSettings(version?: string) {
  return {
    attribution:
      version && parseSemver(version) && compareSemverVersions(version, "2.1.281") >= 0
        ? (false as const)
        : { commit: "", pr: "", sessionUrl: false },
  };
}

/** Flag settings cannot override these managed keys. A policy helper is opaque. */
export function claudeManagedAttributionConflict(
  settings: Omit<Settings, "attribution"> & {
    readonly attribution?: Settings["attribution"] | false;
  },
): boolean {
  const attribution = settings.attribution;
  return (
    Boolean(settings.policyHelper) ||
    (attribution !== undefined &&
      attribution !== false &&
      (Boolean(attribution.commit) || Boolean(attribution.pr) || attribution.sessionUrl === true))
  );
}

const decodeLaunchSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Read the user's --settings input so the session override preserves its other keys. */
export const readClaudeLaunchSettings = Effect.fn("readClaudeLaunchSettings")(function* (
  launchArgs: string,
  cwd: string,
) {
  const raw = parseCliArgs(launchArgs).flags.settings;
  if (!raw) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = raw.trimStart().startsWith("{")
    ? raw
    : yield* fs.readFileString(path.resolve(cwd, raw));
  return yield* decodeLaunchSettings(text);
});

class ClaudeAttributionPolicyProbeError extends Schema.TaggedError<ClaudeAttributionPolicyProbeError>()(
  "ClaudeAttributionPolicyProbeError",
  { cause: Schema.Defect() },
) {}

/** Resolve policy with this instance's config directory without mutating server process.env. */
export const probeClaudeManagedAttribution = (
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) => {
  const code = `import { resolveSettings } from ${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))};
const resolved = await resolveSettings({ settingSources: [] });
const conflict = ${claudeManagedAttributionConflict.toString()};
const managed = resolved.sources.some((entry) => entry.source === "managed" && (entry.settings.attribution !== undefined || entry.settings.policyHelper !== undefined));
process.stdout.write(managed && conflict(resolved.effective) ? "blocked" : "allowed");`;
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<boolean>((resolve, reject) => {
        NodeChildProcess.execFile(
          process.execPath,
          ["--input-type=module", "-e", code],
          {
            ...(cwd === undefined ? {} : { cwd }),
            ...(environment === undefined ? {} : { env: environment }),
            signal,
          },
          (error, stdout) => {
            if (error) return reject(error);
            const result = stdout.trim();
            if (result !== "blocked" && result !== "allowed")
              return reject(new Error("Unexpected managed policy probe response"));
            resolve(result === "blocked");
          },
        );
      }),
    catch: (cause) => new ClaudeAttributionPolicyProbeError({ cause }),
  });
};

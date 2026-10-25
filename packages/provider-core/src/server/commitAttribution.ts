import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const ATTRIBUTION_POLICY_CONFLICT_MESSAGE =
  "Claude managed policy overrides AI attribution suppression or uses a policy helper that Cogenly cannot inspect. Ask your administrator to disable attribution in managed settings.";
export const ATTRIBUTION_POLICY_UNAVAILABLE_MESSAGE =
  "Cogenly could not check Claude's managed attribution policy. No provider session was started.";

export const AI_ATTRIBUTION_INSTRUCTIONS =
  "<commit_attribution>AI attribution is disabled. Do not add AI co-author trailers, generated-with footers, or provider session links to commits or pull request descriptions. Preserve the user's Git author and committer identity and human co-authors. Do not bypass Git hooks or the process Git configuration.</commit_attribution>";

// Keep identities here: the same filter is embedded in the standalone Git hook
// and used for PR descriptions composed by Cogenly. Match complete tool names,
// not human names containing words such as Claude or Grok.
export function stripAiAttribution(message: string): string {
  const toolName =
    /^(?:claude(?:\s+(?:code|opus|sonnet|haiku))?(?:\s+[\d.]+)?(?:\s*\([^\r\n]*\))?|codex(?:\s+cli)?|openai(?:\s+codex)?|muse(?:\s+(?:ai|code))?|grok(?:\s+code)?|xai|x\.ai|(?:github\s+)?copilot(?:\[bot\])?|cursor(?:\s+agent)?|devin|aider|gemini(?:\s+cli)?|ai)\s*$/i;
  const toolEmail =
    /^(?:noreply@(?:anthropic\.com|openai\.com|x\.ai)|(?:claude|codex|muse|grok|copilot|cursoragent|devin|aider|gemini)(?:\[bot\])?@(?:anthropic\.com|openai\.com|x\.ai|github\.com|users\.noreply\.github\.com|cursor\.com)|198982749\+copilot@users\.noreply\.github\.com)$/i;
  const toolMention =
    /\b(?:claude(?:\s+code)?|codex|openai|muse|grok|xai|x\.ai|copilot|cursor|devin|aider|gemini|ai)\b/i;
  return message
    .split(/(?<=\n)/)
    .filter((line) => {
      const text = line.trim();
      const coauthor = /^co-authored-by:\s*(.*?)\s*<([^<>]+)>\s*$/i.exec(text);
      if (coauthor && (toolName.test(coauthor[1]!) || toolEmail.test(coauthor[2]!))) return false;
      if (/^(?:🤖\s*)?generated\s+(?:with|by)\s+/i.test(text) && toolMention.test(text))
        return false;
      if (/^(?:claude|codex|muse|grok|copilot|cursor)[- ]session(?:-url)?:/i.test(text))
        return false;
      if (
        /^(?:\[.*?\]\()?https:\/\/(?:claude\.ai\/code\/|chatgpt\.com\/codex\/)(?:session[_/]|tasks\/)/i.test(
          text,
        )
      )
        return false;
      return true;
    })
    .join("");
}

// Overriding hooksPath affects every hook, so forward the entire documented Git
// hook set. Discover the original path at invocation time, after restoring the
// incoming config environment: cd, worktrees, relative paths and config includes
// must resolve in the repository where Git is actually running.
const GIT_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

const hookProgram = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const stripAiAttribution = ${stripAiAttribution.toString()};
const [hook, ...args] = process.argv.slice(2);
const env = { ...process.env };
const index = Number(env.COGENLY_ATTRIBUTION_CONFIG_INDEX);
if (!Number.isSafeInteger(index) || index < 0) throw new Error('Missing Cogenly Git hook configuration');
delete env['GIT_CONFIG_KEY_' + index];
delete env['GIT_CONFIG_VALUE_' + index];
if (index === 0 && env.COGENLY_ATTRIBUTION_HAD_CONFIG_COUNT !== '1') delete env.GIT_CONFIG_COUNT;
else env.GIT_CONFIG_COUNT = String(index);
delete env.COGENLY_ATTRIBUTION_CONFIG_INDEX;
delete env.COGENLY_ATTRIBUTION_HAD_CONFIG_COUNT;
function clean() {
  if (hook === 'commit-msg') {
    const before = fs.readFileSync(args[0], 'utf8');
    const after = stripAiAttribution(before);
    if (before !== after) fs.writeFileSync(args[0], after);
  }
}
clean();
const lookup = cp.spawnSync('git', ['rev-parse', '--git-path', 'hooks/' + hook], { env, encoding: 'utf8' });
if (lookup.status !== 0) { process.stderr.write(lookup.stderr || 'Cannot resolve repository Git hook'); process.exit(lookup.status || 1); }
const original = path.resolve(lookup.stdout.trim());
let executable = false;
try { fs.accessSync(original, fs.constants.X_OK); executable = fs.statSync(original).isFile(); }
catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
if (executable && original !== path.resolve(__dirname, hook)) {
  // Git's shell fallback also supports executable hooks without a shebang.
  const result = cp.spawnSync('sh', ['-c', 'exec "$0" "$@"', original, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
clean();
`;

/** Adds only a process-local config entry; never writes Git or provider config. */
export function withCommitAttributionEnvironment(
  environment: NodeJS.ProcessEnv,
  hooksPath: string,
  enabled: boolean,
): NodeJS.ProcessEnv {
  if (enabled) return environment;
  // A provider child inherits its parent's protection. Do not stack wrappers.
  if (environment.COGENLY_ATTRIBUTION_CONFIG_INDEX !== undefined) return environment;
  const rawCount = environment.GIT_CONFIG_COUNT;
  const count = rawCount === undefined ? 0 : Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid GIT_CONFIG_COUNT");
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: hooksPath,
    COGENLY_ATTRIBUTION_CONFIG_INDEX: String(count),
    COGENLY_ATTRIBUTION_HAD_CONFIG_COUNT: rawCount === undefined ? "0" : "1",
  };
}

export const prepareCommitAttributionEnvironment = Effect.fn("prepareCommitAttributionEnvironment")(
  function* (environment: NodeJS.ProcessEnv, enabled: boolean) {
    if (enabled || environment.COGENLY_ATTRIBUTION_CONFIG_INDEX !== undefined) return environment;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-commit-hooks-" });
    const program = `${dir}/hook.cjs`;
    yield* fs.writeFileString(program, hookProgram);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const hook of GIT_HOOKS) {
      const target = `${dir}/${hook}`;
      yield* fs.writeFileString(
        target,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} ${quote(hook)} "$@"\n`,
      );
      yield* fs.chmod(target, 0o700);
    }
    return withCommitAttributionEnvironment(environment, dir, false);
  },
);

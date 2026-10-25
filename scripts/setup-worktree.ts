// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the cogenly.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.COGENLY_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error(
    "COGENLY_PROJECT_ROOT is not set. Run this through the cogenly.json setup action.",
  );
}
const worktree = NodePath.dirname(import.meta.dirname);

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
// Install exactly the locked dependencies so setup never rewrites the lockfile.
// A stale lockfile must fail setup rather than silently resolving a new one.
// APFS clones share blocks while keeping package files independently writable.
// Other supported filesystems use hardlinks from pnpm's default shared store.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup runs before dependencies are installed, so HostProcess is unavailable.
const importMethod = process.platform === "darwin" ? "clone" : "hardlink";
const install = NodeChildProcess.spawnSync(
  `vp i --frozen-lockfile -- --yes --package-import-method=${importMethod}`,
  {
    cwd: worktree,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
  },
);
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);

/**
 * `cogenly setup` flags turned into what setup will do, without side effects,
 * so the non-interactive contract scripts and agents rely on is testable.
 *
 * @module cli/setupPlan
 */
import { ProviderInstanceId, type T3ImportSourceProject } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface SetupFlags {
  readonly yes: boolean;
  readonly importT3: boolean;
  readonly projects: Option.Option<string>;
  readonly settings: boolean;
  readonly dryRun: boolean;
  readonly claudeHome: ReadonlyArray<string>;
  readonly codexHome: ReadonlyArray<string>;
  readonly defaultModel: Option.Option<string>;
  readonly sessions: Option.Option<string>;
}

export interface SetupInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: "claudeAgent" | "codex";
  readonly homePath: string;
}

export interface SetupPlan {
  /** Prompt for anything the flags leave open; otherwise do exactly what they say. */
  readonly interactive: boolean;
  readonly instances: ReadonlyArray<SetupInstance>;
  readonly defaultModel: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
  /** `projects` empty means T3's default selection. */
  readonly t3Import: {
    readonly projects: ReadonlyArray<string>;
    readonly includeSettings: boolean;
    readonly dryRun: boolean;
  } | null;
  /** Raw Claude Code / Codex session import: every new folder, or the listed ones. */
  readonly sessions: "all" | ReadonlyArray<string> | null;
}

export type SetupPlanResult =
  | { readonly _tag: "Plan"; readonly plan: SetupPlan }
  | { readonly _tag: "Invalid"; readonly problems: ReadonlyArray<string> };

const decodeInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/**
 * `claude-personal` from `~/.claude_personal`: the driver's prefix plus what
 * the folder name adds to the default `.claude`/`.codex`.
 */
export function deriveInstanceId(prefix: "claude" | "codex", homePath: string): string {
  const base =
    homePath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const rest = base
    .replace(/^\.+/, "")
    .replace(new RegExp(`^${prefix}`, "i"), "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();
  return rest.length === 0 ? `${prefix}-extra` : `${prefix}-${rest}`;
}

function parseInstance(
  driver: SetupInstance["driver"],
  flag: string,
  value: string,
): SetupInstance | string {
  const equals = value.indexOf("=");
  const prefix = driver === "claudeAgent" ? "claude" : "codex";
  const homePath = (equals === -1 ? value : value.slice(equals + 1)).trim();
  const rawId = equals === -1 ? deriveInstanceId(prefix, homePath) : value.slice(0, equals).trim();
  if (homePath.length === 0)
    return `--${flag} ${value}: give a config folder, like id=~/.${prefix}_work.`;
  const instanceId = decodeInstanceId(rawId);
  if (Option.isNone(instanceId)) {
    return `--${flag} ${value}: "${rawId}" is not a valid instance id (letters, digits, - and _, starting with a letter).`;
  }
  return { instanceId: instanceId.value, driver, homePath };
}

/** Validate setup's flags. `terminal` is whether stdin and stdout are a TTY. */
export function resolveSetupPlan(flags: SetupFlags, terminal: boolean): SetupPlanResult {
  const problems: Array<string> = [];
  if (!flags.yes && !terminal) {
    problems.push("Not running in a terminal. Pass --yes and say what to set up with flags.");
  }
  const instances: Array<SetupInstance> = [];
  for (const [driver, flag, values] of [
    ["claudeAgent", "claude-home", flags.claudeHome],
    ["codex", "codex-home", flags.codexHome],
  ] as const) {
    for (const value of values) {
      const parsed = parseInstance(driver, flag, value);
      if (typeof parsed === "string") problems.push(parsed);
      else if (instances.some((instance) => instance.instanceId === parsed.instanceId)) {
        problems.push(`--${flag} ${value}: instance "${parsed.instanceId}" is given twice.`);
      } else instances.push(parsed);
    }
  }
  let defaultModel: SetupPlan["defaultModel"] = null;
  if (Option.isSome(flags.defaultModel)) {
    const value = flags.defaultModel.value.trim();
    const colon = value.indexOf(":");
    const instanceId = colon > 0 ? decodeInstanceId(value.slice(0, colon)) : Option.none();
    const model = colon > 0 ? value.slice(colon + 1).trim() : "";
    if (Option.isNone(instanceId) || model.length === 0) {
      problems.push(
        `--default-model ${value}: use instance:model, like claudeAgent:claude-opus-4-1.`,
      );
    } else defaultModel = { instanceId: instanceId.value, model };
  }
  const projects = Option.match(flags.projects, { onNone: () => [], onSome: list });
  if (!flags.importT3) {
    for (const [given, name] of [
      [Option.isSome(flags.projects), "--projects"],
      [flags.settings, "--settings"],
      [flags.dryRun, "--dry-run"],
    ] as const) {
      if (given) problems.push(`${name} only applies to the T3 Code import; add --import-t3.`);
    }
  }
  const sessions = Option.match(flags.sessions, {
    onNone: () => null,
    onSome: (value) => (value.trim() === "all" ? ("all" as const) : list(value)),
  });
  if (Array.isArray(sessions) && sessions.length === 0) {
    problems.push("--sessions needs `all` or a comma-separated list of folders.");
  }
  if (problems.length > 0) return { _tag: "Invalid", problems };
  return {
    _tag: "Plan",
    plan: {
      interactive: !flags.yes,
      instances,
      defaultModel,
      t3Import: flags.importT3
        ? { projects, includeSettings: flags.settings, dryRun: flags.dryRun }
        : null,
      sessions,
    },
  };
}

/**
 * The T3 project ids `requested` names. Each entry may be a T3 project id,
 * a project title (any case) or its folder.
 */
export function matchT3Projects(
  requested: ReadonlyArray<string>,
  projects: ReadonlyArray<T3ImportSourceProject>,
): { readonly ids: ReadonlyArray<string>; readonly unknown: ReadonlyArray<string> } {
  const ids: Array<string> = [];
  const unknown: Array<string> = [];
  const trimSlash = (value: string) => value.replace(/[\\/]+$/, "");
  for (const entry of requested) {
    const match =
      projects.find((project) => project.sourceProjectId === entry) ??
      projects.find((project) => project.title.toLowerCase() === entry.toLowerCase()) ??
      projects.find((project) => trimSlash(project.workspaceRoot) === trimSlash(entry));
    if (match === undefined) unknown.push(entry);
    else if (!ids.includes(match.sourceProjectId)) ids.push(match.sourceProjectId);
  }
  return { ids, unknown };
}

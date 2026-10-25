// @effect-diagnostics nodeBuiltinImport:off -- Checks the user's provider folders and stdio TTY state at the CLI boundary.
/**
 * `cogenly setup`: the welcome wizard in a terminal. Providers and their
 * accounts, a default model, Import from T3 Code, and the raw session import,
 * through the same services and RPCs the wizard uses (`setupBackend.ts`).
 * `--yes` runs it from flags alone, for scripts and agents.
 *
 * @module cli/setup
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type AgentSessionProjectCandidate,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type T3ImportError,
  type T3ImportJob,
  type T3ImportPhase,
  type T3ImportReport,
  type T3ImportResult,
  type T3ImportStatus,
  T3_IMPORT_RUNNING_NOTE,
  T3_IMPORT_STATUS_HEARTBEAT_MS,
} from "@cogenly/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  isConnectionLoss,
  openSetupBackend,
  type SetupBackend,
  type SetupBackendError,
} from "./setupBackend.ts";
import {
  deriveInstanceId,
  matchT3Projects,
  resolveSetupPlan,
  type SetupInstance,
  type SetupPlan,
} from "./setupPlan.ts";

export class SetupStoppedError extends Schema.TaggedError<SetupStoppedError>()(
  "SetupStoppedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const PHASE_LABELS: Readonly<Record<T3ImportPhase, string>> = {
  snapshot: "Copying T3 Code's data",
  reading: "Reading T3 Code's data",
  backup: "Backing up Cogenly",
  projects: "Setting up projects",
  settings: "Applying settings",
  events: "Importing history",
  attachments: "Copying attachments",
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(1)) : path;

/** Output for humans on stdout, or progress on stderr while stdout carries JSON. */
export interface SetupOutput {
  readonly log: (line: string) => Effect.Effect<void>;
}
const textOutput: SetupOutput = { log: (line) => Console.log(line) };
export const jsonProgressOutput: SetupOutput = { log: (line) => Console.error(line) };

// ── Providers ───────────────────────────────────────────────────────────

const providerName = (provider: ServerProvider) =>
  provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : provider.driver);

function describeProvider(provider: ServerProvider): string {
  const state = !provider.enabled
    ? "turned off"
    : !provider.installed
      ? "not installed"
      : provider.auth.status === "authenticated"
        ? `signed in${provider.auth.email ? ` as ${provider.auth.email}` : ""}`
        : provider.auth.status === "unauthenticated"
          ? "not signed in"
          : "installed";
  return [
    `${providerName(provider)} (${provider.instanceId})`,
    state,
    provider.version ? `v${provider.version}` : null,
    provider.runtimePaths?.homePath ?? null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const instanceHome = (settings: ServerSettings, instanceId: string): string | undefined => {
  const config = settings.providerInstances[instanceId as ProviderInstanceId]?.config;
  const homePath =
    typeof config === "object" && config !== null
      ? (config as { readonly homePath?: unknown }).homePath
      : undefined;
  return typeof homePath === "string" ? homePath.trim() : undefined;
};

const askInstances = Effect.fn("cli.setup.askInstances")(function* (
  existing: ReadonlyArray<SetupInstance>,
) {
  const added = [...existing];
  for (;;) {
    const driver = yield* Prompt.run(
      Prompt.Select({
        message: "Add another account, with its own config folder?",
        choices: [
          { title: "No, continue", value: "done" as const },
          {
            title: "Claude (a CLAUDE_CONFIG_DIR, like ~/.claude_personal)",
            value: "claude" as const,
          },
          { title: "Codex (a CODEX_HOME, like ~/.codex_work)", value: "codex" as const },
        ],
      }),
    );
    if (driver === "done") return added;
    const homePath = yield* Prompt.run(
      Prompt.String({
        message: "Config folder",
        default: driver === "claude" ? "~/.claude_personal" : "~/.codex_work",
      }),
    );
    const instanceId = yield* Prompt.run(
      Prompt.String({
        message: "Name it (an id: letters, digits, - and _)",
        default: deriveInstanceId(driver, homePath),
      }),
    );
    const parsed = resolveSetupPlan(
      {
        yes: true,
        importT3: false,
        projects: Option.none(),
        settings: false,
        dryRun: false,
        claudeHome: driver === "claude" ? [`${instanceId}=${homePath}`] : [],
        codexHome: driver === "codex" ? [`${instanceId}=${homePath}`] : [],
        defaultModel: Option.none(),
        sessions: Option.none(),
      },
      true,
    );
    if (parsed._tag === "Invalid") {
      for (const problem of parsed.problems) yield* Console.log(`  ${problem}`);
      continue;
    }
    added.push(...parsed.plan.instances);
  }
});

const providersStep = Effect.fn("cli.setup.providers")(function* (
  backend: SetupBackend,
  plan: SetupPlan,
  summary: Array<string>,
) {
  yield* Console.log("\nProviders");
  let providers = yield* backend.providers;
  if (backend.target._tag === "offline") {
    yield* Console.log(
      "  Cogenly isn't running, so this is what it saw last time. It checks again when it starts.",
    );
  }
  if (providers.length === 0) {
    yield* Console.log(
      "  None checked yet. Cogenly looks for Claude, Codex and Muse when it starts.",
    );
  }
  for (const provider of providers) {
    yield* Console.log(`  ${describeProvider(provider)}`);
    if (provider.enabled && (!provider.installed || provider.auth.status === "unauthenticated")) {
      if (provider.message) yield* Console.log(`    ${provider.message}`);
      if (provider.setup?.documentationUrl) {
        yield* Console.log(`    Setup: ${provider.setup.documentationUrl}`);
      }
    }
  }

  const instances = plan.interactive ? yield* askInstances(plan.instances) : plan.instances;
  const settings = yield* backend.settings;
  let added = 0;
  for (const instance of instances) {
    const existing = settings.providerInstances[instance.instanceId];
    if (existing !== undefined) {
      const same =
        existing.driver === instance.driver &&
        instanceHome(settings, instance.instanceId) === instance.homePath;
      yield* Console.log(
        same
          ? `  ${instance.instanceId} is already set up.`
          : `  ${instance.instanceId} already exists with a different setup; left as it is.`,
      );
      continue;
    }
    yield* backend.updateSettings(
      {},
      {
        operation: "create",
        instanceId: instance.instanceId,
        instance: {
          driver: ProviderDriverKind.make(instance.driver),
          config: { homePath: instance.homePath },
        },
      },
    );
    added += 1;
    const folder = expandHome(instance.homePath);
    yield* Console.log(
      `  Added ${instance.instanceId} (${instance.homePath}).${NodeFS.existsSync(folder) ? "" : " That folder doesn't exist yet; sign in with this account to create it."}`,
    );
    summary.push(`Added provider ${instance.instanceId} (${instance.homePath})`);
  }
  if (added > 0 && backend.target._tag === "live") {
    providers = yield* backend.providers;
    for (const provider of providers.filter((candidate) =>
      instances.some((instance) => instance.instanceId === candidate.instanceId),
    )) {
      yield* Console.log(`  ${describeProvider(provider)}`);
    }
  }

  // Default model for new chats.
  const usable = providers.filter(
    (provider) =>
      provider.enabled && provider.installed && provider.auth.status !== "unauthenticated",
  );
  const current = settings.defaultModelSelection;
  const currentLabel = current === null ? "none" : `${current.instanceId}:${current.model}`;
  let chosen = plan.defaultModel;
  if (chosen !== null) {
    const { instanceId, model: slug } = chosen;
    const known =
      Object.hasOwn(settings.providerInstances, instanceId) ||
      providers.some((provider) => provider.instanceId === instanceId) ||
      instances.some((instance) => instance.instanceId === instanceId);
    if (!known) {
      return yield* new SetupStoppedError({
        reason: `--default-model: no provider instance named ${instanceId}.`,
      });
    }
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (
      provider !== undefined &&
      !provider.models.some((model) => model.slug === slug || model.aliases?.includes(slug))
    ) {
      yield* Console.log(`  ${slug} isn't in ${instanceId}'s model list; setting it anyway.`);
    }
  } else if (plan.interactive && usable.length > 0) {
    const choices = usable.flatMap((provider) =>
      provider.models
        .filter((model) => !model.isCustom && model.isLegacy !== true)
        .map((model) => ({
          title: `${providerName(provider)} · ${model.name}`,
          value: { instanceId: provider.instanceId, model: model.slug } as const,
        })),
    );
    const picked = yield* Prompt.run(
      Prompt.Select({
        message: "Default model for new chats",
        choices: [{ title: `Keep current (${currentLabel})`, value: null }, ...choices],
        maxPerPage: 12,
      }),
    );
    chosen = picked;
  }
  if (chosen !== null && `${chosen.instanceId}:${chosen.model}` !== currentLabel) {
    yield* backend.updateSettings({
      defaultModelSelection: { instanceId: chosen.instanceId, model: chosen.model },
    });
    yield* Console.log(`  Default model: ${chosen.instanceId}:${chosen.model}`);
    summary.push(`Default model ${chosen.instanceId}:${chosen.model}`);
  } else {
    yield* Console.log(`  Default model: ${currentLabel}`);
  }
});

// ── Import from T3 Code ─────────────────────────────────────────────────

/** The status stream is quiet this long while a job runs: treat the stream as dead and re-attach. */
const STATUS_STALE_MS = T3_IMPORT_STATUS_HEARTBEAT_MS * 6;
/** Re-attach attempts after a drop, two seconds apart: about three minutes of a busy or restarting server. */
const REATTACH_ATTEMPTS = 90;

class StatusStaleError extends Schema.TaggedError<StatusStaleError>()("StatusStaleError", {}) {}
const isStatusStale = Schema.is(StatusStaleError);
/** The stream died or went quiet; the server's job is unaffected, so subscribe again. */
const lostStatus = (error: unknown) => isStatusStale(error) || isConnectionLoss(error);

const progressLine = (job: T3ImportJob) => {
  if (job._tag !== "Scanning" && job._tag !== "Importing") return null;
  const { phase, processedEvents, totalEvents, copiedBytes, totalBytes } = job.progress;
  // The snapshot advances by bytes copied; reading and writing events through a count.
  const percent =
    phase === "snapshot" && totalBytes !== undefined && totalBytes > 0
      ? ` ${Math.floor(((copiedBytes ?? 0) / totalBytes) * 10) * 10}% of ${formatBytes(totalBytes)}`
      : (phase === "reading" || phase === "events") && totalEvents > 0
        ? ` ${Math.floor((processedEvents / totalEvents) * 10) * 10}%`
        : "";
  return `  ${PHASE_LABELS[phase]}…${percent}`;
};

/**
 * The first status satisfying `done`, printing progress along the way. The
 * job runs on the server, so when the connection drops (or the stream goes
 * quiet past several missed heartbeats) this subscribes again and carries on
 * from the job's current state.
 */
export const followJob = (
  backend: SetupBackend,
  output: SetupOutput,
  done: (job: T3ImportJob) => boolean,
) => {
  let lastLine = "";
  return backend.t3Import.status.pipe(
    Stream.timeoutOrElse({
      duration: Duration.millis(STATUS_STALE_MS),
      orElse: () => Stream.fail(new StatusStaleError()),
    }),
    Stream.tapError((error) =>
      lostStatus(error)
        ? output.log("  Lost the connection to Cogenly; reconnecting…")
        : Effect.void,
    ),
    Stream.retry(
      Schedule.spaced(Duration.seconds(2)).pipe(
        Schedule.while(({ input, attempt }) => lostStatus(input) && attempt <= REATTACH_ATTEMPTS),
      ),
    ),
    Stream.tap((status) => {
      const line = progressLine(status.job);
      if (line === null || line === lastLine) return Effect.void;
      lastLine = line;
      return output.log(line);
    }),
    Stream.filter((status) => done(status.job)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.catchTags({ StatusStaleError: () => Effect.fail(connectionLost()) }),
    Effect.mapError((error) => (isConnectionLoss(error) ? connectionLost() : error)),
  );
};

const connectionLost = () =>
  new SetupStoppedError({
    reason:
      "Lost the connection to Cogenly. The job keeps running there; run the same command again to follow it.",
  });

const settled = (job: T3ImportJob) =>
  job._tag === "Scanned" ||
  job._tag === "Completed" ||
  job._tag === "Failed" ||
  job._tag === "Cancelled";

function describeT3Report(report: T3ImportReport): ReadonlyArray<string> {
  const lines = [
    `  ${plural(report.totals.threads, "thread")} · ${plural(report.totals.messages, "message")} · ${plural(report.totals.attachments, "attachment")} (${formatBytes(report.totals.attachmentBytes)})`,
  ];
  for (const project of report.projects) {
    lines.push(
      `  ${project.title}: ${project.action === "merge" ? `into ${project.projectTitle}` : "new project"}, ${plural(project.threads, "thread")}${project.upToDateThreads > 0 ? `, ${project.upToDateThreads} already up to date` : ""}`,
    );
  }
  for (const provider of report.providers) {
    lines.push(
      `  Provider ${provider.instanceId}: ${provider.status === "create" ? "will be added" : provider.status === "conflict" ? "set up differently here; resuming may start fresh sessions" : "ready"}`,
    );
  }
  if (report.totals.skippedEvents > 0) {
    lines.push(`  ${plural(report.totals.skippedEvents, "event")} can't be read and are left out.`);
  }
  // The step already said T3 Code is open, before the check.
  for (const warning of report.warnings) {
    if (warning !== T3_IMPORT_RUNNING_NOTE) lines.push(`  Note: ${warning}`);
  }
  if (report.totals.newEvents === 0) lines.push("  Nothing new to import.");
  return lines;
}

function describeT3Result(result: T3ImportResult): ReadonlyArray<string> {
  return [
    `  Imported ${plural(result.importedThreads, "thread")} (${plural(result.writtenEvents, "event")}, ${plural(result.copiedAttachments, "attachment")}).`,
    `  Backup of Cogenly from before the import: ${result.backupPath}`,
    "  Run it again any time: nothing is duplicated, and only what changed in T3 Code since comes over.",
  ];
}

interface T3ImportStepOptions {
  readonly interactive: boolean;
  /** T3 project ids, titles or folders; empty means T3's default selection. */
  readonly projects: ReadonlyArray<string>;
  readonly includeSettings: boolean;
  readonly dryRun: boolean;
  readonly output: SetupOutput;
}

type T3ImportStepOutcome =
  | { readonly _tag: "Unavailable"; readonly reason: string }
  | { readonly _tag: "Declined" }
  | { readonly _tag: "Scanned"; readonly report: T3ImportReport }
  | { readonly _tag: "Imported"; readonly result: T3ImportResult };

/** Detect, choose projects, dry run, confirm, import: the Settings → Import flow. */
export const runT3ImportStep = Effect.fn("cli.setup.t3Import")(function* (
  backend: SetupBackend,
  options: T3ImportStepOptions,
) {
  const { log } = options.output;
  const first = yield* backend.t3Import.status.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
  const source: T3ImportStatus["source"] = first.source;
  if (!source.available) {
    const reason = source.error ?? "No T3 Code data was found on this machine.";
    yield* log(`  ${reason}`);
    return { _tag: "Unavailable", reason } satisfies T3ImportStepOutcome;
  }
  if (source.running) yield* log(`  ${T3_IMPORT_RUNNING_NOTE}`);

  const requested = matchT3Projects(options.projects, source.projects);
  if (requested.unknown.length > 0) {
    return yield* new SetupStoppedError({
      reason: `No T3 Code project matches ${requested.unknown.join(", ")}. Known: ${source.projects.map((project) => project.title).join(", ")}.`,
    });
  }
  let projectIds = requested.ids;
  if (options.interactive) {
    projectIds = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Which T3 Code projects?",
        choices: source.projects.map((project) => ({
          title: `${project.title} (${plural(project.threadCount, "thread")})`,
          description: `${project.workspaceRoot}${project.existingProjectTitle ? ` · merges into ${project.existingProjectTitle}` : ""}${project.isScratch ? " · files under No project" : ""}`,
          value: project.sourceProjectId,
          selected:
            projectIds.length > 0
              ? projectIds.includes(project.sourceProjectId)
              : project.selectedByDefault,
        })),
        min: 1,
      }),
    );
  }

  // A job already running on the server (an earlier run lost its connection,
  // or Settings → Import started it) is followed instead of refused as busy.
  if (first.job._tag === "Importing") {
    yield* log("  An import is already running; following it.");
    return yield* followImport(backend, options.output);
  }
  if (first.job._tag === "Scanning") {
    yield* log("  A check is already running; following it.");
  } else {
    yield* log("  Checking what will be imported (nothing is written yet)…");
    yield* backend.t3Import.scan({ scope: { sourceProjectIds: [...projectIds] } });
  }
  const scanned = yield* followJob(backend, options.output, settled);
  if (scanned.job._tag === "Failed") {
    return yield* new SetupStoppedError({ reason: scanned.job.message });
  }
  if (scanned.job._tag !== "Scanned") {
    return yield* new SetupStoppedError({ reason: "The check was stopped." });
  }
  const report = scanned.job.report;
  for (const line of describeT3Report(report)) yield* log(line);
  if (scanned.source.backupDirectory) {
    yield* log(`  Cogenly backs up its database first, to ${scanned.source.backupDirectory}.`);
  }
  // Like Settings → Import: nothing new means no import, and no backup either.
  if (options.dryRun || report.totals.newEvents === 0) {
    return { _tag: "Scanned", report } satisfies T3ImportStepOutcome;
  }

  let includeSettings = options.includeSettings && report.settings.length > 0;
  if (options.interactive) {
    if (report.settings.length > 0) {
      includeSettings = yield* Prompt.run(
        Prompt.Confirm({
          message: `Also bring over ${report.settings.map((change) => change.setting).join(", ")}?`,
          initial: true,
        }),
      );
    }
    const go = yield* Prompt.run(Prompt.Confirm({ message: "Import now?", initial: true }));
    if (!go) return { _tag: "Declined" } satisfies T3ImportStepOutcome;
  }

  yield* backend.t3Import.run({ reportId: report.reportId, includeSettings });
  return yield* followImport(backend, options.output);
});

/** Follow a started import to its end. */
const followImport = Effect.fn("cli.setup.t3Import.follow")(function* (
  backend: SetupBackend,
  output: SetupOutput,
) {
  const finished = yield* followJob(
    backend,
    output,
    (job) => job._tag === "Completed" || job._tag === "Failed" || job._tag === "Cancelled",
  ).pipe(
    // Ctrl-C stops the server's job between batches instead of leaving it running.
    Effect.onInterrupt(() => backend.t3Import.cancel.pipe(Effect.ignore)),
  );
  switch (finished.job._tag) {
    case "Completed":
      for (const line of describeT3Result(finished.job.result)) yield* output.log(line);
      return { _tag: "Imported", result: finished.job.result } satisfies T3ImportStepOutcome;
    case "Failed":
      return yield* new SetupStoppedError({
        reason: `${finished.job.message}${finished.job.backupPath ? ` Backup: ${finished.job.backupPath}` : ""}`,
      });
    default:
      return yield* new SetupStoppedError({
        reason: "The import was stopped. What was written stays; run it again to continue.",
      });
  }
});

// ── Raw sessions ────────────────────────────────────────────────────────

const sessionsStep = Effect.fn("cli.setup.sessions")(function* (
  backend: SetupBackend,
  plan: SetupPlan,
  importedFromT3: boolean,
  summary: Array<string>,
) {
  if (plan.sessions === null && !plan.interactive) return;
  yield* Console.log("\nClaude Code and Codex sessions");
  if (Option.isNone(backend.sessions)) {
    yield* Console.log("  This import needs Cogenly running. Start it and run setup again.");
    return;
  }
  const sessions = backend.sessions.value;
  if (plan.sessions === null) {
    const wanted = yield* Prompt.run(
      Prompt.Confirm({
        message: importedFromT3
          ? "Also import raw Claude Code and Codex sessions? Chats you had in T3 Code would come in twice."
          : "Import raw Claude Code and Codex sessions from this computer?",
        initial: false,
      }),
    );
    if (!wanted) return;
  }
  const scan = yield* sessions.scan;
  const fresh = scan.candidates.filter((candidate) => !candidate.alreadyImported);
  if (fresh.length === 0) {
    yield* Console.log("  No new folders with sessions.");
    return;
  }
  let picked: ReadonlyArray<AgentSessionProjectCandidate>;
  if (plan.sessions === "all") picked = fresh;
  else if (plan.sessions !== null) {
    const wanted = plan.sessions.map((folder) => NodePath.resolve(expandHome(folder)));
    picked = fresh.filter((candidate) => wanted.includes(NodePath.resolve(candidate.path)));
    const missing = wanted.filter(
      (folder) => !picked.some((c) => NodePath.resolve(c.path) === folder),
    );
    if (missing.length > 0) {
      yield* Console.log(`  No new sessions found for ${missing.join(", ")}.`);
    }
  } else {
    picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Which folders?",
        choices: fresh.map((candidate) => ({
          title: `${candidate.title} (${plural(candidate.threadCount, "session")})`,
          description: candidate.path,
          value: candidate,
        })),
      }),
    );
  }
  let imported = 0;
  let skipped = 0;
  for (const candidate of picked) {
    const result = yield* sessions.importCandidate(candidate);
    imported += result.importedCount;
    skipped += result.skippedCount;
    yield* Console.log(`  ${candidate.title}: ${plural(result.importedCount, "thread")}`);
  }
  if (picked.length > 0) {
    summary.push(
      `Imported ${plural(imported, "session thread")} from ${plural(picked.length, "folder")}${skipped > 0 ? ` (${skipped} couldn't be imported)` : ""}`,
    );
  }
});

// ── Command ─────────────────────────────────────────────────────────────

export const describeSetupFailure = (
  error: SetupBackendError | T3ImportError | SetupStoppedError,
) =>
  error._tag === "SetupBackendError" && error.cause instanceof Error && error.cause.message
    ? `${error.message} ${error.cause.message}`
    : error.message;

const runSetup = Effect.fn("cli.setup")(function* (backend: SetupBackend, plan: SetupPlan) {
  const summary: Array<string> = [];
  yield* Console.log(
    backend.target._tag === "live"
      ? `Setting up the running Cogenly at ${backend.target.origin}.`
      : `Cogenly isn't running; setting up ${backend.target.baseDir} directly.`,
  );

  yield* providersStep(backend, plan, summary);

  yield* Console.log("\nThis computer");
  yield* Console.log(
    backend.target._tag === "live"
      ? `  ${backend.target.environmentLabel} is this environment already; nothing to do. Add more computers in Settings → Connections.`
      : "  Becomes this environment when Cogenly starts; nothing to do.",
  );

  let importedFromT3 = false;
  if (plan.t3Import !== null || plan.interactive) {
    yield* Console.log("\nImport from T3 Code");
    const wanted =
      plan.t3Import !== null ||
      (yield* Prompt.run(Prompt.Confirm({ message: "Import from T3 Code?", initial: true })));
    if (wanted) {
      const outcome = yield* runT3ImportStep(backend, {
        interactive: plan.interactive,
        projects: plan.t3Import?.projects ?? [],
        includeSettings: plan.t3Import?.includeSettings ?? true,
        dryRun: plan.t3Import?.dryRun ?? false,
        output: textOutput,
      });
      if (outcome._tag === "Imported") {
        importedFromT3 = true;
        summary.push(
          `Imported ${plural(outcome.result.importedThreads, "thread")} from T3 Code; backup at ${outcome.result.backupPath}`,
        );
      } else if (outcome._tag === "Scanned") {
        summary.push("Checked the T3 Code import (dry run; nothing written)");
      }
    }
  }

  yield* sessionsStep(backend, plan, importedFromT3, summary);

  yield* Console.log("\nSummary");
  if (summary.length === 0) yield* Console.log("  Nothing changed.");
  for (const line of summary) yield* Console.log(`  ${line}`);
});

const setupFlags = {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Don't prompt: do what the flags say and nothing else."),
    Flag.withDefault(false),
  ),
  importT3: Flag.Boolean("import-t3").pipe(
    Flag.withDescription("Import from T3 Code (T3 Code may stay open)."),
    Flag.withDefault(false),
  ),
  projects: Flag.String("projects").pipe(
    Flag.withDescription(
      "T3 Code projects to import, comma-separated ids, titles or folders. Default: every non-scratch project with threads.",
    ),
    Flag.optional,
  ),
  settings: Flag.Boolean("settings").pipe(
    Flag.withDescription(
      "With --import-t3: also bring over default models, favorites and keybindings.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("With --import-t3: report what would be imported and stop."),
    Flag.withDefault(false),
  ),
  claudeHome: Flag.String("claude-home").pipe(
    Flag.withDescription(
      "Add a Claude account with its own config folder: [id=]path, like claude-personal=~/.claude_personal. Repeatable.",
    ),
    Flag.atLeast(0),
  ),
  codexHome: Flag.String("codex-home").pipe(
    Flag.withDescription("Add a Codex account with its own CODEX_HOME: [id=]path. Repeatable."),
    Flag.atLeast(0),
  ),
  defaultModel: Flag.String("default-model").pipe(
    Flag.withDescription("Default model for new chats, as instance:model."),
    Flag.optional,
  ),
  sessions: Flag.String("sessions").pipe(
    Flag.withDescription(
      "Import raw Claude Code and Codex sessions: `all` new folders, or comma-separated folders. Needs Cogenly running.",
    ),
    Flag.optional,
  ),
};

export const setupCommand = Command.make("setup", setupFlags).pipe(
  Command.withDescription(
    "Set up Cogenly from the terminal: providers, default model, Import from T3 Code. Works while Cogenly and T3 Code run.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolved = resolveSetupPlan(
        flags,
        Boolean(process.stdin.isTTY && process.stdout.isTTY),
      );
      if (resolved._tag === "Invalid") {
        return yield* new SetupStoppedError({ reason: resolved.problems.join("\n") });
      }
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const backend = yield* openSetupBackend(config, { label: "cogenly setup cli" });
      yield* runSetup(backend, resolved.plan);
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        QuitError: () => Console.log("\nSetup stopped. Run `cogenly setup` again any time."),
        SetupBackendError: (error) =>
          Effect.fail(new SetupStoppedError({ reason: describeSetupFailure(error) })),
        T3ImportError: (error) => Effect.fail(new SetupStoppedError({ reason: error.detail })),
      }),
    ),
  ),
);

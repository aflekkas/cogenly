import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@cogenly/contracts";
import { sourceControlClients } from "@cogenly/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@cogenly/shared/keybindings";
import { commandLabel, RETIRED_KEYBINDING_COMMANDS } from "./KeybindingsSettings.logic";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/project-tags"
  | "/settings/memory"
  | "/settings/vault"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/storage"
  | "/settings/data"
  | "/settings/import"
  | "/settings/connections"
  | "/settings/machines"
  | "/settings/archived"
  | "/settings/models"
  | "/settings/new-threads";

/**
 * A searchable setting. Search and deep links keep the selected machine, and
 * every row renders whichever machine is selected.
 */
export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  /** Descriptions, option labels, and aliases people may remember instead of the title. */
  readonly searchTerms?: ReadonlyArray<string>;
  // Its row only renders in the desktop app, so a browser result would land on
  // an anchor that isn't there.
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  // Its row only renders on Windows desktop, so other desktop platforms must
  // not expose a result that points to a missing anchor.
  readonly windowsOnly?: boolean;
  // Its row renders only in a hosted web build deployed with a release
  // channel. The desktop app has no channel row, so it never shows this result.
  readonly hostedChannelOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  // Its row only renders while this environment's Cogenly Connect managed tunnel is on.
  readonly managedTunnelOnly?: boolean;
  /**
   * Sorts after every other match. Keybinding commands mirror rows on other
   * surfaces, so "model" must still lead with Default model, not Model Picker.
   */
  readonly secondary?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly managedTunnelActive?: boolean;
}

/**
 * Section labels. The sidebar nav, the breadcrumb, the command palette and
 * the search-result subtitles all render from this record, so each label
 * exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/models": "Models",
  "/settings/integrations": "Integrations",
  "/settings/memory": "Memory",
  "/settings/scheduled-tasks": "Scheduled tasks",
  "/settings/vault": "Vault",
  "/settings/project-tags": "Projects",
  "/settings/projects": "Repositories",
  "/settings/new-threads": "New threads",
  "/settings/source-control": "Source control",
  "/settings/machines": "Machines",
  "/settings/connections": "Connections",
  "/settings/storage": "Storage",
  "/settings/data": "Data",
  "/settings/import": "Import",
  "/settings/diagnostics": "Diagnostics",
  "/settings/archived": "Archive",
};

/**
 * The settings sidebar, in order. The first group has no heading. Detail
 * pages are reached from a page and highlight it instead, see
 * `SETTINGS_DETAIL_PARENTS`.
 */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly label: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  { label: null, paths: ["/settings/general", "/settings/appearance", "/settings/keybindings"] },
  { label: "Models & providers", paths: ["/settings/providers", "/settings/models"] },
  {
    label: "Agents",
    paths: [
      "/settings/integrations",
      "/settings/memory",
      "/settings/scheduled-tasks",
      "/settings/vault",
    ],
  },
  {
    label: "Projects",
    paths: ["/settings/project-tags", "/settings/new-threads", "/settings/source-control"],
  },
  { label: "Machines", paths: ["/settings/machines", "/settings/connections"] },
  {
    label: "Advanced",
    paths: [
      "/settings/storage",
      "/settings/data",
      "/settings/import",
      "/settings/diagnostics",
      "/settings/archived",
    ],
  },
];

/** Pages outside the sidebar, and the sidebar page each one belongs to. */
export const SETTINGS_DETAIL_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/projects": "/settings/project-tags",
  "/settings/open-source-licenses": "/settings/general",
};

/** The sidebar entry to highlight for `pathname`, or null outside Settings. */
export function settingsNavPathFor(pathname: string): SettingsPath | null {
  const normalized = pathname.replace(/\/+$/, "");
  const parent = SETTINGS_DETAIL_PARENTS[normalized];
  if (parent) return parent;
  for (const group of SETTINGS_NAV_GROUPS) {
    const match = group.paths.find(
      (path) => normalized === path || normalized.startsWith(`${path}/`),
    );
    if (match) return match;
  }
  return null;
}

/**
 * Where a link to a row that moved off General now lands. Old links keep
 * their anchor, so `/settings/general#default-model` opens the Models page
 * at that row.
 */
const MOVED_GENERAL_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "default-model": "/settings/models",
  "text-generation": "/settings/models",
  "text-generation-model": "/settings/models",
  "project-defaults": "/settings/new-threads",
  "new-threads": "/settings/new-threads",
  "worktree-submodules": "/settings/new-threads",
  "start-from-origin": "/settings/new-threads",
  "projects-and-threads": "/settings/project-tags",
  "add-project-starts-in": "/settings/project-tags",
  "projects-folder": "/settings/project-tags",
  "project-actions": "/settings/projects",
  diagnostics: "/settings/diagnostics",
  "time-format": "/settings/appearance",
};

/** The new page for an old General anchor, or null when it still lives on General. */
export function movedGeneralSettingsPath(hash: string): SettingsPath | null {
  return MOVED_GENERAL_ANCHORS[hash.replace(/^#/, "")] ?? null;
}

/** Anchor id of the first row bound to `command` on the Keybindings page. */
export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

/**
 * One result per built-in command, alphabetical by label. The anchor is
 * the command's first row; default keys are searchable so "mod+b" lands on
 * Sidebar: Toggle. A command with no default binding may have no row, so it
 * points at the section instead.
 */
const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.filter(
  (command) => !RETIRED_KEYBINDING_COMMANDS.has(command),
)
  .toSorted((left, right) => commandLabel(left).localeCompare(commandLabel(right)))
  .map((command) => {
    const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
      (binding) => binding.key,
    );
    return {
      id: keybindingSearchAnchorId(command),
      title: commandLabel(command),
      to: "/settings/keybindings" as const,
      searchTerms: [command, ...defaultKeys],
      secondary: true,
      ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
    };
  });

/** Anchor id of a source control host's settings form on the Source Control page. */
export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** One result per host whose definition declares settings, searchable by its field titles. */
const SOURCE_CONTROL_HOST_SEARCH_ITEMS = sourceControlClients.definitions.flatMap((definition) =>
  definition.settings && definition.kind !== "github"
    ? [
        {
          id: sourceControlHostSettingsSearchId(definition.kind),
          title: `${definition.label} credentials`,
          to: "/settings/source-control" as const,
          searchTerms: [
            `${definition.label} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
          ],
          environmentOnly: true,
        },
      ]
    : [],
);

/**
 * Searchable settings and stable destinations, in result order. Rows with a
 * dedicated anchor render their id and title via `searchableSetting`; items
 * that may not be mounted point at their nearest stable section instead.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "Keep ignored local files too",
    to: "/settings/storage",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "Clean up now",
    to: "/settings/storage",
    searchTerms: [
      "storage cleanup free up space preview cleanup dry run run now last run results report removed kept failed unsaved agent worktrees",
    ],
  },
  {
    id: "storage-backup-retention",
    title: "Nightly backups",
    to: "/settings/storage",
    searchTerms: ["nightly backup snapshots retention database disk space cleanup"],
  },
  {
    id: "storage-dependencies",
    targetId: "storage-artifacts",
    title: "Prune idle dependencies",
    to: "/settings/storage",
    searchTerms: ["node_modules pnpm shared store hardlinks dist turbo disk usage dev data copies"],
  },
  {
    id: "storage-worktrees",
    title: "Worktree cleanup",
    to: "/settings/storage",
    searchTerms: [
      "disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    to: "/settings/storage",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Build files, captures and logs",
    to: "/settings/storage",
    searchTerms: [
      "artifacts and logs disk storage browser artifacts screenshots captures rotated logs cleanup retention",
    ],
  },
  {
    id: "project-defaults",
    title: "Workspace",
    to: "/settings/new-threads",
    searchTerms: [
      "new threads defaults workspace worktree submodules start from origin repositories cogenly.json",
    ],
  },
  {
    id: "memory",
    title: "Memory",
    to: "/settings/memory",
    searchTerms: [
      "facts remember something forget correct context proposed proposals confirm reject private agents knowledge",
      "sync synced syncing other machines offline",
    ],
  },
  {
    id: "vault",
    title: "Vault",
    to: "/settings/vault",
    searchTerms: [
      "secrets passwords logins credentials api keys cards notes one-time codes totp approvals access ask first usage log recent activity",
      "share vault sharing sync synced other machines this machine only keep on this machine",
      "logins sign in username email favicon site allow block missing username add email integration signs in with",
    ],
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    to: "/settings/scheduled-tasks",
    searchTerms: [
      "schedule cron recurring timer interval daily weekdays automation automate run prompt automatically paused active",
      "webhook url trigger event github signature deliveries",
    ],
  },
  {
    id: "data-export",
    title: "Export",
    to: "/settings/data",
    searchTerms: [
      "export backup download portable data jsonl validate check bundle recent exports",
    ],
  },
  {
    id: "t3-import",
    title: "Import from T3 Code",
    to: "/settings/import",
    searchTerms: ["import migrate t3 code move projects threads history keybindings"],
  },
  {
    id: "project-overview",
    title: "Repository overview",
    to: "/settings/projects",
    searchTerms: ["project repository repo overview name icon image checkout remove delete"],
  },
  {
    id: "default-model",
    title: "Default model",
    to: "/settings/models",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    // The Appearance page as a whole; its rows below land on themselves.
    id: "appearance",
    title: "Appearance",
    to: "/settings/appearance",
    searchTerms: ["look theme colors display"],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode theme"],
  },
  {
    id: "accent-color",
    title: "Accent color",
    to: "/settings/appearance",
    searchTerms: ["appearance theme brand primary color orange blue violet green pink"],
  },
  {
    id: "diff-colors",
    title: "Diff colors",
    to: "/settings/appearance",
    searchTerms: [
      "appearance theme added removed lines red green blue orange color blind colorblind accessibility",
    ],
  },
  {
    id: "font-size",
    title: "Font size",
    to: "/settings/appearance",
    searchTerms: ["appearance text size zoom small large scale"],
  },
  {
    id: "chat-width",
    title: "Chat width",
    to: "/settings/appearance",
    searchTerms: ["appearance layout thread timeline composer wide full comfortable column"],
  },
  {
    id: "sidebar-layout",
    title: "Sidebar layout",
    to: "/settings/appearance",
    searchTerms: ["appearance layout sidebar search dock top bottom anchored list order"],
  },
  {
    id: "usage-meters",
    title: "Usage meters",
    to: "/settings/appearance",
    searchTerms: ["appearance usage limits quota bars remaining left used fills drains"],
  },
  {
    id: "reduce-motion",
    title: "Reduce motion",
    to: "/settings/appearance",
    searchTerms: ["appearance layout animation motion accessibility"],
  },
  {
    id: "project-grouping",
    title: "Repository grouping",
    to: "/settings/general",
    searchTerms: ["project grouping combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: "Repository order",
    to: "/settings/general",
    searchTerms: ["project order sort projects repositories sidebar manual created recent"],
  },
  {
    id: "snooze-limited-threads",
    title: "Snooze at usage limits",
    to: "/settings/general",
    searchTerms: ["snooze limited threads usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "Resume after usage limits",
    to: "/settings/general",
    searchTerms: [
      "auto-resume limited threads automatically usage quota rate limit reset recover continue",
    ],
  },
  {
    id: "working-shelf",
    title: "Working section (beta)",
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "thread-notifications",
    title: "Thread notifications",
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    title: "In-app notifications",
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/appearance",
    searchTerms: ["appearance display timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "Response streaming",
    to: "/settings/general",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "skills-in-slash-menu",
    title: "Skills in the slash menu",
    to: "/settings/general",
    searchTerms: ["show skills command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: "Rich text composer",
    to: "/settings/general",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "composer-dictation",
    title: "Dictation",
    to: "/settings/general",
    searchTerms: ["voice speech microphone mic dictate transcribe talk speak"],
    desktopOnly: true,
    macOnly: true,
  },
  {
    id: "send-shortcut",
    title: "Send shortcut",
    to: "/settings/general",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: "Follow-up behavior",
    to: "/settings/general",
    searchTerms: ["queue steer running turn send default behavior composer while agent works"],
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
    searchTerms: ["installed cli versions newer available codex claude muse grok"],
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue threads after restarts",
    to: "/settings/general",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    to: "/settings/general",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "Start new threads in",
    to: "/settings/new-threads",
    searchTerms: ["new threads default workspace mode draft local current checkout worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Worktree submodules",
    to: "/settings/new-threads",
    searchTerms: ["git submodule init recursive top-level none worktree cogenly.json"],
  },
  {
    id: "start-from-origin",
    title: "Start worktrees from origin",
    to: "/settings/new-threads",
    searchTerms: ["new worktrees latest matching remote branch local fetch"],
  },
  {
    id: "add-project-starts-in",
    title: "Folder browser starts in",
    to: "/settings/project-tags",
    searchTerms: ["add repository project base directory folder browser path home"],
  },
  {
    id: "projects-folder",
    title: "Projects folder",
    to: "/settings/project-tags",
    searchTerms: ["projects root cogenly clone new repository location directory path"],
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: "Quit shortcut",
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit quit right away hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/models",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "ai-greetings",
    title: "AI greetings",
    to: "/settings/general",
    searchTerms: ["new chat greeting headline hello welcome message generated recent work"],
  },
  {
    id: "app-version",
    title: "Version",
    to: "/settings/general",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    title: "Update track",
    to: "/settings/general",
    searchTerms: ["release channel latest nightly prerelease"],
    hostedChannelOnly: true,
  },
  {
    id: "cli-command",
    title: "cogenly command",
    to: "/settings/general",
    searchTerms: ["cli terminal shell path install uninstall command line tool usr local bin"],
    desktopOnly: true,
  },
  {
    id: "telemetry-export",
    title: "OpenTelemetry export",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/diagnostics",
    searchTerms: [
      "logs traces trace diagnostics live processes resource monitor resource history failures repeated failures slowest spans span logs warnings errors top span names most frequent cpu memory",
    ],
  },
  {
    id: "open-source-licenses",
    title: "Open-source licenses",
    to: "/settings/general",
    searchTerms: ["about third-party notices open source oss dependencies"],
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    to: "/settings/general",
    searchTerms: ["build plan composer old"],
  },
  {
    id: "legacy-context-window-indicator",
    title: "Context window indicator (legacy)",
    to: "/settings/general",
    searchTerms: ["composer meter usage tokens circle old"],
  },
  {
    id: "legacy-sidebar",
    title: "Sidebar (legacy)",
    to: "/settings/general",
    searchTerms: ["project thread tree old flat list"],
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: [
      "agents cli codex claude muse grok sign in sign out install subscription instances authentication api key models configuration binary path config directory endpoint arguments environment variables display name accent color custom hidden auto compact",
    ],
  },
  {
    id: "provider-health-check-interval",
    title: "Health check interval",
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "integration-services",
    title: "Services",
    to: "/settings/integrations",
    searchTerms: [
      "integrations mcp servers connect remote gmail google workspace calendar drive docs linear notion github slack wispr flow fathom accounts sign in status needs sign-in error test tools",
    ],
  },
  {
    id: "integration-add",
    // Its row waits for the account list; the section is always there.
    targetId: "integration-services",
    title: "Add integration",
    to: "/settings/integrations",
    searchTerms: [
      "connect a service with an agent new account custom mcp server setup oauth client id secret api key personal access token slack app manifest google cloud install uv",
    ],
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/integrations",
    searchTerms: [
      "agent access allow disable enable open drive shared browser preview tools sessions",
    ],
  },
  {
    id: "agent-computer-use",
    title: "Computer use",
    to: "/settings/integrations",
    searchTerms: [
      "agent access allow disable enable control mac apps click type screenshot accessibility screen recording macos permission system settings privacy",
    ],
  },
  {
    id: "device-hosts",
    title: "Device hosts",
    to: "/settings/integrations",
    searchTerms: ["ssh remote simulator emulator ios android mac mini identity key connection"],
  },
  {
    id: "agent-device-access",
    title: "Agent device access",
    to: "/settings/integrations",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: "Device hub",
    to: "/settings/integrations",
    searchTerms: ["simulator emulator ios android install start"],
  },
  {
    id: "device-platform-support",
    title: "Simulator support",
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-cookie-import",
    title: "Import sign-ins from another browser",
    to: "/settings/integrations",
    targetId: "browser-cookie-import",
    searchTerms: ["cookies chrome dia arc safari firefox logins sessions"],
  },
  {
    id: "browser-profiles",
    title: "Browser profiles",
    to: "/settings/integrations",
  },
  {
    id: "browser-extensions",
    title: "Browser extensions",
    to: "/settings/integrations",
    searchTerms: ["chrome web store chromium add-ons plugins ad blocker password manager"],
  },
  {
    id: "browser-default-profile",
    title: "Default browser profile",
    to: "/settings/integrations",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: "Default tab size",
    to: "/settings/integrations",
    searchTerms: ["browser viewport preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: "Default tab zoom",
    to: "/settings/integrations",
    searchTerms: ["browser preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: "Tab color scheme",
    to: "/settings/integrations",
    searchTerms: [
      "default browser appearance preview color scheme light dark system os match cogenly theme",
    ],
  },
  {
    id: "browser-recording-frame-rate",
    title: "Recording frame rate",
    to: "/settings/integrations",
    searchTerms: ["browser recordings fps video capture smooth"],
  },
  {
    id: "browser-recording-key-presses",
    title: "Show key presses",
    to: "/settings/integrations",
    searchTerms: ["browser recordings preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: "Show clicks",
    to: "/settings/integrations",
    searchTerms: ["browser recordings preview mouse presses buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: "Open links in",
    to: "/settings/integrations",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "automatic-pull",
    title: "Automatically pull",
    to: "/settings/source-control",
    searchTerms: ["auto pull default branch current checkout fast forward upstream git"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "Remove agent credits when merging",
    to: "/settings/source-control",
    searchTerms: ["pull request github squash co-authored-by attribution claude codex generated"],
  },
  {
    id: "pull-request-merge-method",
    title: "Default merge method",
    to: "/settings/source-control",
    searchTerms: ["pull request merge squash rebase last used selected button"],
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
    searchTerms: [
      "version control git github hosting integrations credentials scan rescan machine sign in",
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/source-control",
    searchTerms: [
      "background fetch automatic remote branch refresh credentials security keys seconds off",
    ],
    environmentOnly: true,
  },
  {
    id: "worktree-branch-naming",
    title: "Branch names",
    to: "/settings/source-control",
    searchTerms: [
      "worktree branch naming static semantic prefix custom prompt instructions feat fix refactor chore",
    ],
    environmentOnly: true,
  },
  {
    id: "github-accounts",
    title: "GitHub accounts and token",
    to: "/settings/source-control",
    searchTerms: [
      "github gh account login user host enterprise ghes switch multiple accounts disable sign in token personal access token pat api key credential",
    ],
    environmentOnly: true,
  },
  ...SOURCE_CONTROL_HOST_SEARCH_ITEMS,
  {
    id: "source-control-writing-style",
    title: "Writing style",
    to: "/settings/source-control",
    searchTerms: [
      "source control commit messages pull request titles descriptions repository conventions conventional commits custom instructions",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "Use pull request templates",
    to: "/settings/source-control",
    searchTerms: ["follow change request template repository pr description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "Writing model",
    to: "/settings/source-control",
    searchTerms: [
      "source control writer model override generated commit messages pull request pr titles descriptions branch names",
    ],
    environmentOnly: true,
  },
  {
    id: "project-actions",
    title: "Repository actions",
    to: "/settings/projects",
    searchTerms: [
      "actions commands scripts setup run dev server checkout worktree cogenly.json import repository",
    ],
  },
  {
    id: "environment-icon",
    title: "Machine icon",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["environment glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: "Local environment",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    targetId: "connections-remote-access",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "WSL backend",
    to: "/settings/connections",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: "Cogenly Connect",
    to: "/settings/connections",
    targetId: "connections-remote-access",
    searchTerms: ["managed tunnel cloud other devices remote"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "Hold webhooks while offline",
    to: "/settings/connections",
    targetId: "connections-remote-access",
    searchTerms: ["webhook automations offline queue mailbox cogenly connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "Publish agent activity",
    to: "/settings/connections",
    targetId: "connections-remote-access",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "This machine",
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links pair a device qr code authorized clients devices with access sessions revoke endpoint",
    ],
  },
  {
    id: "remote-environments",
    title: "Connected machines",
    to: "/settings/connections",
    searchTerms: [
      // No "pair": pairing machines to each other lives on the Machines page.
      "connect a machine add environments remote server backend host link code url ssh config agent tunnel saved cogenly connect",
    ],
  },
  {
    id: "load-balancing",
    title: "Load balancing",
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "github-routing",
    title: "GitHub sharing",
    to: "/settings/connections",
    searchTerms: ["pull request trusted environments shared credentials permissions read actions"],
  },
  {
    id: "machines",
    title: "Machines",
    to: "/settings/machines",
    searchTerms: [
      "pair paired pairing unpair hub always-on sync computers laptops servers online offline tailscale",
      "private access tailscale serve https magicdns tailnet",
    ],
  },
  {
    id: "add-machine",
    title: "Add a machine",
    to: "/settings/machines",
    targetId: "machines",
    searchTerms: ["pair new computer laptop server tailscale sign in https link sync"],
  },
  {
    id: "machine-health",
    title: "Machine health",
    to: "/settings/machines",
    searchTerms: [
      "status checks broken failing problems alerts reachable offline disk database providers scheduled tasks stuck runs retry sync",
    ],
  },
  {
    id: "health-auto-fix",
    title: "Fix problems automatically",
    to: "/settings/machines",
    searchTerms: ["health auto fix self heal sync stuck runs automatic"],
  },
  {
    id: "health-canary",
    title: "Canary check",
    to: "/settings/machines",
    searchTerms: ["health test schedule interval always-on hub end to end monitor"],
  },
  {
    id: "health-slack-alerts",
    title: "Slack alerts",
    to: "/settings/machines",
    searchTerms: ["health alert channels external notify direct message dm member id test alert"],
  },
  {
    id: "health-email-alerts",
    title: "Email alerts",
    to: "/settings/machines",
    searchTerms: ["health alert channels external notify gmail google workspace test alert"],
  },
  {
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
    searchTerms: ["archive unarchive restore reopen delete deleted history projects"],
  },
  {
    id: "project-folders",
    title: "Projects",
    to: "/settings/project-tags",
    searchTerms: [
      "folders new project archive github org sources files agents repositories",
      "leftover folders orphan unused without a project deleted project turn into project adopt move to trash remove clean up tidy projects root",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  return items
    .flatMap((item, index) => {
      if (!isElectron && item.desktopOnly === true) return [];
      if (item.hostedChannelOnly && (isElectron || HOSTED_APP_CHANNEL === null)) return [];
      if (item.macOnly && !isMacPlatform(platform)) return [];
      if (item.windowsOnly && !isWindowsPlatform(platform)) return [];

      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

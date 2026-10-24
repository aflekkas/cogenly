import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { commandLabel, RETIRED_KEYBINDING_COMMANDS } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

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
 * Where a setting can be edited. Device-local rows have no scope: they render
 * at every selection. `environment` rows live on a machine page,
 * `environment-defaults` rows outside a project, and `project` rows only at a
 * project. `project-defaults` rows accept project overrides, so they are
 * reachable from any server-backed selection.
 */
export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  /** Descriptions, option labels, and aliases people may remember instead of the title. */
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
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
  "/settings/projects": "Repository",
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
  "projects-and-threads": "/settings/new-threads",
  "add-project-starts-in": "/settings/new-threads",
  "projects-folder": "/settings/new-threads",
  "project-actions": "/settings/new-threads",
  diagnostics: "/settings/diagnostics",
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
          scope: "environment-defaults" as const,
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
    title: "Keep worktrees with local changes",
    to: "/settings/storage",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "Delete now",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: "Worktree cleanup",
    to: "/settings/storage",
    scope: "project-defaults",
    searchTerms: [
      "disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Artifacts and logs",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["disk storage browser screenshots captures rotated logs cleanup retention"],
  },
  {
    id: "project-defaults",
    title: "New threads",
    to: "/settings/new-threads",
    scope: "project-defaults",
    searchTerms: [
      "project defaults overrides workspace worktree submodules start from origin machines projects repositories inheritance all projects",
    ],
  },
  {
    id: "memory",
    title: "Memory",
    to: "/settings/memory",
    searchTerms: ["facts remember forget correct context proposed confirm agents knowledge"],
  },
  {
    id: "vault",
    title: "Vault",
    to: "/settings/vault",
    searchTerms: [
      "secrets passwords logins credentials api keys cards notes one-time codes totp approvals usage log",
    ],
  },
  {
    id: "data-export",
    title: "Export",
    to: "/settings/data",
    searchTerms: ["export backup download portable data jsonl validate bundle"],
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
    scope: "project-defaults",
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
    id: "font-size",
    title: "Font size",
    to: "/settings/appearance",
    searchTerms: ["appearance text size zoom small large scale"],
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
    searchTerms: ["appearance animation motion accessibility"],
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
    title: "Snooze limited threads",
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "Auto-resume limited threads",
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset recover continue"],
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
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "Response streaming",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "skills-in-slash-menu",
    title: "Show skills in slash menu",
    to: "/settings/general",
    searchTerms: ["command menu dollar $ slash /"],
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
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
    searchTerms: ["installed cli versions newer available codex claude muse grok"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue threads after restarts",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "Workspace",
    to: "/settings/new-threads",
    scope: "project-defaults",
    searchTerms: ["new threads default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Submodules",
    to: "/settings/new-threads",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree cogenly.json"],
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    to: "/settings/new-threads",
    scope: "project-defaults",
    searchTerms: ["new worktrees latest matching remote branch local"],
  },
  {
    id: "add-project-starts-in",
    title: "Add repository starts in",
    to: "/settings/new-threads",
    scope: "environment-defaults",
    searchTerms: ["add project base directory folder browser path home"],
  },
  {
    id: "projects-folder",
    title: "Projects folder",
    to: "/settings/new-threads",
    scope: "environment-defaults",
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
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/models",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
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
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "telemetry-export",
    title: "OpenTelemetry export",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/diagnostics",
    searchTerms: ["logs traces live processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: "Open source licenses",
    to: "/settings/general",
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
    id: "usage-providers",
    title: "Usage providers",
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
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
      "integrations mcp servers connect remote gmail google workspace calendar drive linear notion github atlassian jira confluence intercom slack wispr flow fathom figma catalog accounts sign in tools vault credentials headers add custom",
    ],
  },
  {
    id: "provider-connectors",
    title: "Use provider connectors too",
    to: "/settings/integrations",
    searchTerms: [
      "claude.ai connectors chatgpt apps codex plugins mcp servers duplicate native gmail slack notion linear",
    ],
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: [
      "agent access allow disable enable open drive shared browser preview tools sessions project override",
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
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: "Device hub",
    to: "/settings/integrations",
    targetId: "devices",
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
    id: "browser-profiles",
    title: "Browser profiles",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: "Default browser profile",
    to: "/settings/integrations",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    to: "/settings/integrations",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    to: "/settings/integrations",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    to: "/settings/integrations",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: "Browser recording frame rate",
    to: "/settings/integrations",
  },
  {
    id: "browser-recording-key-presses",
    title: "Show key presses in recordings",
    to: "/settings/integrations",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: "Show mouse presses in recordings",
    to: "/settings/integrations",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
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
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "Remove agent credits when merging",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request github squash co-authored-by attribution claude codex generated"],
  },
  {
    id: "pull-request-merge-method",
    title: "Default merge method",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      "version control git github hosting integrations credentials scan server environment",
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/source-control",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "Worktree branch naming",
    to: "/settings/source-control",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "github-accounts",
    title: "GitHub accounts and token",
    to: "/settings/source-control",
    searchTerms: [
      "github gh account login user host enterprise ghes switch multiple accounts disable sign in token personal access token pat api key credential",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  ...SOURCE_CONTROL_HOST_SEARCH_ITEMS,
  {
    id: "source-control-writing-style",
    title: "Source control writing style",
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "Follow change request templates",
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "Source control writer model",
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "Actions",
    to: "/settings/new-threads",
    scope: "project",
    searchTerms: ["commands scripts setup run dev server checkout worktree cogenly.json import"],
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
    targetId: "connections-environment",
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
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "Hold webhooks while offline",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox cogenly connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "Publish agent activity",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "This machine",
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
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
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
    searchTerms: ["restore reopen deleted history projects"],
  },
  {
    id: "project-folders",
    title: "Projects",
    to: "/settings/project-tags",
    searchTerms: [
      "folders new project archive github org sources files agents repositories",
      "orphan folders outside any project adopt as project remove empty projects root",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  // The Repository page follows its own `repository` key.
  "/settings/projects": null,
  "/settings/general": null,
  "/settings/project-tags": null,
  "/settings/memory": null,
  "/settings/vault": null,
  "/settings/data": null,
  "/settings/import": null,
  "/settings/appearance": null,
  // Keybindings fan out to every machine; Providers, Machines and Storage
  // always resolve to one machine. None needs a particular scope to render.
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/integrations": null,
  "/settings/source-control": "environment-defaults",
  "/settings/storage": "project-defaults",
  "/settings/connections": "connections",
  "/settings/machines": null,
  "/settings/scheduled-tasks": null,
  "/settings/archived": "project-defaults",
  "/settings/models": null,
  "/settings/new-threads": null,
};

/** Search keeps the selected target. A missing row can explain its owning scope instead. */
export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
      }
    : null;
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "project":
      return requiredScope === scopeKind;
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return scopeKind === "environment" || scopeKind === "all" || scopeKind === "project";
  }
}

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

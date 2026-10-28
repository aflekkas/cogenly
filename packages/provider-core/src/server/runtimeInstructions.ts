import type { IntegrationConnectionStatus } from "@cogenly/contracts";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>When link_pull_request is exposed, register every PR you create or work on immediately with its full URL, including every stack layer. CLI/API creates and updates do not register links; relinking is safe. Before finishing, list_thread_pull_requests and link missing work PRs; exclude background-only mentions. Report linking failures accurately. For monitoring, watch_pull_request then end the turn: Cogenly wakes on checks, comments or conflicts; never poll or run a watcher. Before handing back to the user, unwatch_pull_request so the thread returns to their inbox.</pull_request_linking>`;

/**
 * How Cogenly itself works, for every provider in chat and Work. The agent
 * needs this to organize projects, file threads, and set agents up when the
 * user asks in plain words.
 */
export const HOW_COGENLY_WORKS_INSTRUCTIONS = `<how_cogenly_works>Chats answer questions, look up and read/write project files, never edit repositories. Work changes one repository. Agents persist with chats/triggers. Create/suggest projects only for multi-repo efforts. Single repos and side/class projects stay in "No project" (clone without a project). Project chats use <projectsRoot>/<Project>/ (repos/files); Work uses its repo. Filing a chat forks it with history, preserving the original. Use Cogenly tools for projects, repos/GitHub owners, filing, agents/builders; confirm bulk/destructive changes. Use thread_snooze/unsnooze/settle/unsettle; snooze until accepts words/presets.</how_cogenly_works>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
const VAULT_INSTRUCTIONS = `<vault>Never expose secrets in chat/DOM output. vault_capture page secrets, never snapshot/extract/evaluate; vault_save created credentials. vault_fill types privately. vault_list: metadata/site-grouped logins (id/label/username, no passwords). Before sign-ins/integration consoles, list/reuse matching itemId; choose_login requires its candidates, never guess. If none fits, request_login then fill its vaultItemId. For missingUsername, request_login with updateItemId and fields ['username']; for rejected credentials request_login with updateItemId. Apply this in scheduled runs too (timeoutMs 3600000). Never ask for, invent, repeat or type secrets yourself: request_login for sign-ins, request_secret otherwise; saveToVault when it should persist. Continue without a declined secret. Cards persist past waits; every answer (including Deny) notifies/steers/starts this thread, respecting Stop/queue holds. Allowed-site fills need no approval; approval_required already asked the owner. Say you're waiting on the card, never ask them to allow it or type continue. After approval retry vault_fill with fresh locator. vault_link_integration associates logins.</vault>`;

export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in Cogenly through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. Link absolute paths in Markdown to embed images/videos or hand the user other files as openable attachments, e.g. [a.pdf](/Users/me/a.pdf); wrap paths with spaces in <>.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${HOW_COGENLY_WORKS_INSTRUCTIONS}\n\n${VAULT_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

/** Resource paths listed in the project manifest before `+N more`. */
export const PROJECT_MANIFEST_MAX_RESOURCES = 30;

/** One configured integration and its current health, as the context line names it. */
export interface IntegrationContextEntry {
  readonly status: IntegrationConnectionStatus | "disabled";
  readonly name: string;
  readonly displayName: string;
  readonly hint?: string | undefined;
  /** Which account of the service, e.g. "Spawn Partners". */
  readonly accountLabel?: string | undefined;
}

/**
 * The one line every provider turn gets about integrations, e.g.
 * "Connected integrations: gmail (Gmail, aflekkas@…), linear-spawn (Linear ·
 * Spawn Partners). Use integration_tools / integration_call. Also available
 * to connect with integration_add catalogId: notion, slack." `available` are
 * catalog ids not connected yet. Empty when there is neither.
 * `providerConnectorsHidden` adds that the provider's own connectors for these
 * services are off, so the agent does not go looking for them.
 */
export function buildIntegrationsContextLine(
  integrations: ReadonlyArray<IntegrationContextEntry>,
  available: ReadonlyArray<string> = [],
  providerConnectorsHidden = false,
): string {
  const line = integrationsLine(integrations, available);
  return line.length > 0 && providerConnectorsHidden
    ? `${line} ${PROVIDER_CONNECTORS_HIDDEN_TEXT}`
    : line;
}

const PROVIDER_CONNECTORS_HIDDEN_TEXT =
  "Use Cogenly integrations. The provider's own MCP servers, connectors, plugins and apps are off; only MCP servers checked into the repository still load.";

function integrationsLine(
  integrations: ReadonlyArray<IntegrationContextEntry>,
  available: ReadonlyArray<string>,
): string {
  const availableText =
    available.length === 0
      ? ""
      : `${integrations.length === 0 ? "Integrations available" : "Also available"} to connect: ${available.map(toSingleLine).join(", ")}. When the user asks for one of these, do not just say it isn't connected: offer to connect it, read integration_setup_guide, then start the connect flow with integration_add (its catalogId) and give the user the sign-in link it returns.`;
  if (integrations.length === 0) return availableText;
  const nameOf = (integration: IntegrationContextEntry) => {
    const hint = integration.hint?.trim() ?? "";
    const account = integration.accountLabel?.trim() ?? "";
    const label =
      account.length > 0
        ? [`${integration.displayName} · ${account}`, hint].filter(Boolean).join(", ")
        : hint.length > 0
          ? hint
          : integration.displayName !== integration.name
            ? integration.displayName
            : "";
    return label.length > 0
      ? `${toSingleLine(integration.name)} (${toSingleLine(label)})`
      : toSingleLine(integration.name);
  };
  const working = integrations.filter((entry) => entry.status === "connected");
  const remaining = integrations.filter((entry) => entry.status !== "connected");
  const connected =
    working.length === 0
      ? ""
      : `Connected integrations: ${working.map(nameOf).join(", ")}. Use integration_tools / integration_call.`;
  const other =
    remaining.length === 0
      ? ""
      : `Other integrations: ${remaining.map((entry) => `${nameOf(entry)}: ${entry.status === "needs_sign_in" ? "needs sign-in" : entry.status === "unknown" ? "not checked" : entry.status}`).join(", ")}.`;
  return [connected, other, availableText].filter(Boolean).join(" ");
}

/**
 * Compact manifest of the thread's project folder, appended to the turn
 * context for chats and Work threads filed in a project. Paths are
 * project-relative; the directory is the edge-resolved absolute path.
 */
export function buildProjectManifest(input: {
  readonly name: string;
  readonly directory: string;
  readonly resources: ReadonlyArray<string>;
  readonly total: number;
  /** The project's instructions; blank adds nothing. */
  readonly instructions?: string | undefined;
  /** True for the project's own chat, which also gets PROJECT_CHAT_INSTRUCTIONS. */
  readonly projectChat?: boolean | undefined;
  /** Connected integrations visible from this project; adds one tiny line. */
  readonly integrations?: ReadonlyArray<IntegrationContextEntry> | undefined;
  /** Catalog ids not connected yet, named on the same line. */
  readonly availableIntegrations?: ReadonlyArray<string> | undefined;
  /** See `buildIntegrationsContextLine`. */
  readonly providerConnectorsHidden?: boolean | undefined;
}): string {
  const shown = input.resources.slice(0, PROJECT_MANIFEST_MAX_RESOURCES);
  const files =
    shown.length === 0
      ? "(no project files yet)"
      : shown.map((resource) => `- ${toSingleLine(resource)}`).join("\n");
  const more = input.total - shown.length;
  const manifest = `<project_manifest>The thread's project folder is "${toSingleLine(input.name)}" at ${toSingleLine(input.directory)}. Project files:\n${files}${more > 0 ? `\n+${more} more` : ""}\nUse project_recall to search these files and project_file_read to read one. To add a repository to a project, use project_label_clone_repository (it clones into the project folder and registers it); do not git clone by hand.</project_manifest>`;
  const instructions = input.instructions?.trim() ?? "";
  const integrationsLine = buildIntegrationsContextLine(
    input.integrations ?? [],
    input.availableIntegrations,
    input.providerConnectorsHidden === true,
  );
  return [
    manifest,
    ...(integrationsLine.length === 0 ? [] : [integrationsLine]),
    ...(instructions.length === 0
      ? []
      : [
          `<project_instructions>The user set these instructions for every thread in this project; follow them:\n${instructions}\n</project_instructions>`,
        ]),
    ...(input.projectChat === true ? [PROJECT_CHAT_INSTRUCTIONS] : []),
  ].join("\n");
}

/**
 * The project's own chat configures and runs its project. Appended to the
 * project manifest for that one thread, so every adapter carries it.
 */
export const PROJECT_CHAT_INSTRUCTIONS = `<project_chat>This is the project's own chat, the place the user configures and runs this project from. Act on requests about the project yourself with the cogenly project tools; they target this project by default:
- project_overview shows its repositories (with ids), GitHub sources and instructions. Check it before changing anything.
- Repositories: project_repository_add / project_repository_remove for repositories already on this machine (find ids with project_list); project_label_clone_repository clones a GitHub repository into the project.
- Sources: project_source_link / project_source_unlink for GitHub owners or repositories.
- Instructions: project_instructions_get, then project_instructions_set with the whole new text. Keep them short and in the user's words.
- Files: project_files_list, project_file_read, project_recall, project_file_write (saves a note) and project_file_remove.
Before removing a repository, source or file, or replacing instructions the user did not dictate, confirm in one short sentence and wait. Each change returns a receipt the user sees as a card, so do not restate it at length.
For coding work (changing a repository's code, fixing or building something, long-running builds or tests) do not try to do it here: start it with work_task, targeting the right repository, and say what it will do. Answer questions about the project from project_recall and the file tools before guessing.</project_chat>`;

const CONVERSATION_LOOKUPS_WITH_TERMINAL = `<conversation_mode>You are in a conversation, not a coding session. Answer directly; code snippets in replies are fine.

Look things up yourself with the cogenly terminal_run tool: search and list files, read files and git history (git log, diff, status), and run read-only CLI queries. Commands start in this chat's folder and can read the user's files except credentials: Cogenly's data, provider logins, SSH keys and saved CLI tokens are hidden, so CLIs that need a login, such as gh, run signed out. Use Cogenly's tools or a task for signed-in work. Run the lookups and answer here; never hand a question to a task just to run commands or read files. The terminal sandbox blocks local file writes outside its private temporary directory for the whole process tree. Network remains available: you must not run commands that change remote state (including API mutations, messages, pushes or releases). Do not change anything from here: no repository edits, commits or pushes, installs, settings changes, or servers. Keep each command quick.

When a request needs changes (changing a repository's code, installing or uninstalling apps, editing settings on this machine) or long-running work such as builds and test suites, do not tell the user to do it by hand.`;

const CONVERSATION_LOOKUPS_WITHOUT_TERMINAL = `<conversation_mode>You are in a conversation, not a coding session: commands are unavailable on this machine or for this turn; you cannot run commands or change files here, so answer directly instead of changing anything. Code snippets in replies are fine.

When a request needs commands, files, code, or other tools (changing a repository, installing or uninstalling apps, editing settings on this machine), do not tell the user to do it by hand.`;

/**
 * System prompt for chat-surface turns. The thread is a conversation, not a
 * coding session: the adapter drops native file writes and the native shell.
 * With the Cogenly terminal tools attached (`terminal`), the agent runs its
 * own lookups; changes and long-running work go to a task through work_task
 * instead of back to the user. It also biases visual answers toward inline
 * pictures. Every adapter appends this same text.
 */
export const conversationModeInstructions = (options: {
  readonly terminal: boolean;
  readonly builder?: boolean | undefined;
}) =>
  options.builder === true
    ? "<builder_mode>You are helping set up a Cogenly agent. Follow the agent builder instructions and use propose_agent for proposals. Do not read or change files, run commands, delegate, or start Work tasks here.</builder_mode>"
    : `${options.terminal ? CONVERSATION_LOOKUPS_WITH_TERMINAL : CONVERSATION_LOOKUPS_WITHOUT_TERMINAL} Hand it to a task with the work_task tool. A task is a new top-level Work thread the user can see and follow, with its own project or environment; it reports its result back to this chat, and you then tell the user the outcome, so never poll it. A subagent is different: internal helper work inside one thread, which conversations do not have. Here you only start tasks.
- mode "start" when the user explicitly asked for this action and it is unambiguous and low-risk, or when they clearly instructed destructive work themselves (for example "uninstall those two apps"). Otherwise mode "propose": the user gets a card to approve, edit or dismiss. Err toward propose for anything destructive (deleting files, uninstalling, resetting) that the user did not clearly ask for.
- Pick the target: one of the user's projects (see project_list) when the work belongs to it, or no targetProjectId for work on this machine itself, which runs in No project.
- Write the brief as complete instructions for the task agent: goal, steps or constraints, and what done looks like.
- Pass settleWhenDone=true when the reported result is all the user needs (no pull request or diff to review), so the task's Work thread settles itself once it completes instead of lingering.
- In your reply, say in a sentence what the task will do and where, and whether it started or waits for approval.
If work_task is unavailable, explain what you would do and suggest Start Work (the hammer on a message).

When the user asks what something looks like, asks for pictures, or the topic is inherently visual (people, places, products, species, designs, UI), include 1-4 relevant images near the relevant text, each on its own line followed by a short caption and its source link, like \`![alt](url) *Caption* · [Source](page)\`. Use only real image URLs from search results or the image_search tool (prefer Wikimedia, official sites, and fandom static CDNs); never invent URLs, and skip images when none are found.</conversation_mode>`;

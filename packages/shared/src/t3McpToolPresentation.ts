export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "project-label-create"
  | "project-label-update"
  | "project-label-delete"
  | "project-label-link"
  | "project-label-clone"
  | "project-label-file-thread"
  | "agent-list"
  | "agent-builder-start"
  | "agent-project-move"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "image-search"
  | "project-files-list"
  | "project-file-read"
  | "project-recall";

export interface T3McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: T3McpToolSummaryAction;
}

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolSummaryAction,
  icon: T3McpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): T3McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

/** The name the app's MCP server is injected under in every provider session. */
export const T3_MCP_SERVER_NAME = "cogenly";

// Legacy upstream spellings stay recognized so transcripts recorded before the rename still render.
const T3_MCP_SERVER_ALIASES = new Set([T3_MCP_SERVER_NAME, "t3-code", "t3_code", "t3code"]);

/** Strips the `t3_` prefix tools carried before the rename, so old transcripts still resolve. */
export function withoutLegacyToolPrefix(tool: string): string {
  return tool.startsWith("t3_") ? tool.slice(3) : tool;
}

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "Cogenly threads"], "thread-create"),
  thread_start: tool(["Start", "Starting", "Started", "a Cogenly thread"], "thread-create"),
  thread_list: tool(["List", "Listing", "Listed", "Cogenly threads"], "thread-list"),
  thread_read: tool(["Read", "Reading", "Read", "a Cogenly thread"], "thread-read"),
  thread_send: tool(["Send", "Sending", "Sent", "to a Cogenly thread"], "thread-send"),
  thread_wait: tool(["Wait", "Waiting", "Waited", "for a Cogenly thread"], "thread-wait"),
  workflow_stop: tool(["Stop", "Stopping", "Requested a stop for", "a workflow"], "workflow-stop"),
  thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Cogenly thread"],
    "thread-interrupt",
  ),
  worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_permission: tool(
    ["Set", "Setting", "Set", "a site permission in the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_setup_status: tool(["Check", "Checking", "Checked", "device setup"], "device", "device"),
  device_setup: tool(["Set up", "Setting up", "Set up", "devices"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  pending_request_list: tool(["List", "Listing", "Listed", "pending questions"], "question-list"),
  pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  thread_snooze: tool(["Snooze", "Snoozing", "Snoozed", "a thread"], "thread-organize"),
  thread_unsnooze: tool(["Wake", "Waking", "Woke", "a thread"], "thread-organize"),
  thread_settle: tool(["Settle", "Settling", "Settled", "a thread"], "thread-organize"),
  thread_unsettle: tool(["Unsettle", "Unsettling", "Unsettled", "a thread"], "thread-organize"),
  thread_update: tool(
    ["Update", "Updating", "Updated", "Cogenly thread metadata"],
    "thread-update",
  ),
  worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  environment_add: tool(["Add", "Adding", "Added", "a server"], "environment-update"),
  thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  project_label_list: tool(["List", "Listing", "Listed", "project folders"], "project-list"),
  project_label_read: tool(["Read", "Reading", "Read", "a project folder"], "project-read"),
  project_label_create: tool(
    ["Create", "Creating", "Created", "a project folder"],
    "project-label-create",
  ),
  project_label_update: tool(
    ["Update", "Updating", "Updated", "a project folder"],
    "project-label-update",
  ),
  project_label_delete: tool(
    ["Delete", "Deleting", "Deleted", "a project folder"],
    "project-label-delete",
  ),
  project_label_archive: tool(
    ["Archive", "Archiving", "Archived", "a project folder"],
    "project-label-update",
  ),
  project_label_unarchive: tool(
    ["Unarchive", "Unarchiving", "Unarchived", "a project folder"],
    "project-label-update",
  ),
  project_label_link_source: tool(
    ["Link", "Linking", "Linked", "a source to a project"],
    "project-label-link",
  ),
  project_label_unlink_source: tool(
    ["Unlink", "Unlinking", "Unlinked", "a source from a project"],
    "project-label-link",
  ),
  project_label_link_repository: tool(
    ["Add", "Adding", "Added", "a repository to a project"],
    "project-label-link",
  ),
  project_label_unlink_repository: tool(
    ["Remove", "Removing", "Removed", "a repository from a project"],
    "project-label-link",
  ),
  project_label_clone_repository: tool(
    ["Clone", "Cloning", "Started cloning", "a repository into a project"],
    "project-label-clone",
  ),
  project_label_file_thread: tool(
    ["File", "Filing", "Filed", "a thread into a project"],
    "project-label-file-thread",
  ),
  thread_move_project_folder: tool(
    ["File", "Filing", "Filed", "a thread into a project"],
    "thread-organize",
  ),
  thread_set_project_labels: tool(
    ["File", "Filing", "Filed", "a thread into a project"],
    "thread-organize",
  ),
  list_agents: tool(["List", "Listing", "Listed", "agents"], "agent-list"),
  update_agent_project: tool(
    ["Move", "Moving", "Moved", "an agent to a project"],
    "agent-project-move",
  ),
  start_agent_builder: tool(
    ["Start", "Starting", "Started", "an agent builder"],
    "agent-builder-start",
  ),
  attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  image_search: tool(["Search", "Searching", "Searched", "the web for images"], "image-search"),
  project_files_list: tool(["List", "Listing", "Listed", "project files"], "project-files-list"),
  project_file_read: tool(["Read", "Reading", "Read", "a project file"], "project-file-read"),
  project_recall: tool(["Search", "Searching", "Searched", "project files"], "project-recall"),
};

/**
 * The T3 orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const T3_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T3_MCP_TOOLS));

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected Cogenly server prefixes its tools:
 * `mcp__t3-code__x` (Claude/Cursor), `t3-code.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? withoutLegacyToolPrefix(tool)
      : null;
  }

  const namespaceMatch =
    /^(?<server>cogenly|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    const tool = namespaceMatch.groups.tool;
    return tool === undefined ? null : withoutLegacyToolPrefix(tool);
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:cogenly|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
    label,
  );
  const candidate = withoutLegacyToolPrefix(prefixed?.groups?.tool ?? label);
  if (Object.hasOwn(T3_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 registers one server per thread, `t3-code-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^(?:cogenly|t3-code)-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(T3_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

/** The bare T3 tool name (`html_render`) for any provider's spelling of it. */
export function resolveT3McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? name : null;
}

export function resolveT3McpToolDefinition(
  toolName: string | null | undefined,
): T3McpToolDefinition | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? T3_MCP_TOOLS[name]! : null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
): T3McpToolPresentation | null {
  const definition = resolveT3McpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}

export function resolveT3McpToolSummaryAction(
  toolName: string | null | undefined,
): T3McpToolSummaryAction | null {
  return resolveT3McpToolDefinition(toolName)?.summaryAction ?? null;
}

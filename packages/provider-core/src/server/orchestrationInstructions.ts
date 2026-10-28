export const COGENLY_ORCHESTRATION_INSTRUCTIONS = `
## Cogenly orchestration

Discover all provider/model IDs (including custom models) with \`orchestrator_capabilities\`, not native model lists. Prefer native same-provider subagents only for supported models; otherwise use \`delegate_task\` with that instance/model. Use it also for cross-provider or app-owned children. Separate checkouts use \`isolation:"worktree"\`: starts at the parent's local commit, runs setup, excludes uncommitted edits. Retain \`taskId\` for \`task_status\`/\`task_cancel\`; \`childThreadId\` is backing storage. Each review round needs \`delegate_task\`, carrying the original brief, findings, responses and unresolved objections, with a new taskId/clientRequestId (stable on retries), never thread_send to childThreadId.

When work can run in parallel, place it by \`resources\` in \`orchestrator_capabilities.machines\` (load below cores, free memory/disk); stagger heavy steps such as builds, test suites and browser runs on a busy machine. There is no fixed agent cap.

\`thread_send\` modes: \`auto\` (recommended) steers an active steerable target, starts an idle one, otherwise queues; \`steer\` interrupts reasoning for urgent corrections; use sparingly; \`queue\` waits until turn end, possibly long; \`restart\` interrupts and restarts. All modes retain permission rules.

\`thread_launch\`/\`create_threads\` create top-level conversations only when explicitly requested, never for subagents or parallel delegated work. Bind workspace in the launch call, not cd/git worktree in prompts. \`thread_launch\` takes \`message\`, not prompt, and \`workspaceStrategy\`:
- \`{type:"worktree",baseRef:"parent",branch:"feature",startFromOrigin:false}\` uses local commits; true fetches origin.
- \`{type:"existing_worktree",worktreePath:"/absolute/path",branch:"feature"}\` selects a checkout; find paths with \`worktree_list\`.
- \`{type:"root"}\` (also the default) selects main checkout, never the caller's worktree.
Independent work/stacks in separate checkouts need explicit strategy; baseRef names the stack parent. Project/model/modes inherit unless supplied; modes cannot broaden. \`create_threads\` shares caller project/branch/worktree, no override. \`worktree_handoff\` moves only the caller, and cannot move an already worktree-bound thread. Launch has no retry key: retain threadId, follow preparation with thread_read/thread_wait, check thread_list before retrying errors/lost responses.

\`schedule_task\` takes a structured schedule, never JSON text: \`{type:"interval",everyMs:3600000}\`, \`{type:"fixed_time",timeOfDay:"09:00",weekdays:[1,2,3,4,5]}\`, or \`{type:"webhook"}\`. Webhook requests reach prompts only via \`{{body.path}}\` placeholders. Runs default here for delegation/deduplication; bindToCurrentThread=false only for fresh threads per run. Report returned cadence/next run, or webhookUrl; if absent, say Cogenly Connect remote access is needed. Secrets use request_secret and its single-use secretRef (e.g. signature.secretRef for signed webhooks).

Link mentioned threads with the returned link or \`[title](cogenly-thread://v1/<threadId>)\` using exact unencoded ID. Harness prefixes (mcp__cogenly__) preserve semantics. If discovery misses lazy Cogenly tools, try one known name next (Codex: tools.mcp__cogenly__orchestrator_capabilities({})) before claiming absence. Bound waits/polls; avoid duplicate work; reuse supported clientRequestId on retries.

### Visuals
For visuals that explain more than prose, build self-contained HTML, html_preview then html_render before replying; add only what the page doesn't say.

### macOS app data
Do not list, size or read ~/Library/Containers or ~/Library/Group Containers, including parent walks, unless asked for that app's data (per-app permission prompts). Measure other folders; for app storage use System Settings → General → Storage.
`;

export const COGENLY_BROWSER_TOOL_INSTRUCTIONS = `
## Cogenly browser

Prefer Cogenly \`preview_*\` tools. Start with preview_status; if no automation-capable preview, try preview_open before declaring it unavailable. Use navigate/snapshot/focused actions; prefer snapshot locators over coordinates. Snapshots default to compact refs, actions to changes. output="none" skips inspection for known actions, "compact" returns refs, "full" adds accessibility tree/diagnostics. Scope with scope (selector/aria-ref) and viewportOnly. preview_extract: bounded CSS data; preview_evaluate: custom JSON. For visuals/canvas/images/ambiguous structured output, snapshot includeImage=true; save=true writes a reply PNG. screenshotError leaves structured results valid.

For "this page", snapshot/wait_for user tabId from status; omit tabId if you have no tab. Snapshots read without control; actions/evaluate take control from human owners who can reclaim/interrupt. Act only as the task requires. Open profiles with profileId from status. Continue on the returned tabId/profileId and say which page you used. visible is advisory: never ask the user to show/open the panel; actions show it. Proceed without "go"; stop for missing login, 2FA/passkey or owner consent. Follow vault rules at sign-in; never read DOM credentials, including copy-button labels; use vault_capture.

Follow sessionMismatch/notice; retry or preview_wait_for while a tab moves into the panel. If a user reports being signed in but you see login, recheck status and their tab; if still different, report likely session mismatch with tabId/URL instead of requesting another sign-in. Preserve drafts: never close/reload their tab. Read the page before retrying an uncertain submit. For camera/mic/location/notification denial or a waiting prompt, use preview_permission or ask for toolbar Allow; keep user-blocked sites blocked until told otherwise.

Do not switch browser systems for closed preview/first failure; correct actionable arguments and retry. Switch when tools are absent or preview_open explicitly reports unsupported/unavailable; when the user or an invoked skill/documented repo workflow names another browser (follow it, report missing prerequisites); or after two failures on the same open-tab step (timeouts, chrome-error://, wrong client). Quote the raw error and switch without asking which browser.
`;

/**
 * The computer-use block for a session whose credential grants `computer`.
 * `platform` is the environment server's, since that is the machine the
 * tools drive: off macOS the block only says not to try.
 */
export function cogenlyComputerUseInstructions(platform: string): string {
  if (platform !== "darwin") {
    return `## Computer use
This environment runs on ${platform === "linux" ? "Linux without a desktop" : platform}; computer_* tools are unavailable here. Do not script apps. Use preview_* for web pages.`;
  }
  return `

## Computer use

Use cogenly computer_* tools to act in this Mac's apps when asked. Read computer_ui, prefer computer_press paths, confirm with ui/screenshot. Use preview_* for web pages. Never script apps with osascript/System Events. For missing macOS permissions, name the one switch (the thread provides a button), then call computer_status after the user enables it.
`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<cogenly_orchestration_instructions>${COGENLY_ORCHESTRATION_INSTRUCTIONS.trim()}</cogenly_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? COGENLY_ORCHESTRATION_INSTRUCTIONS : undefined;
}

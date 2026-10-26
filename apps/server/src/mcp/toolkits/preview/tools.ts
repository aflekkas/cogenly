import {
  BrowserCookieImportInput,
  BrowserCookieImportResult,
  BrowserCookieImportError,
  BrowserImportSource,
  CookieDomain,
} from "@cogenly/contracts";
import * as ServerBrowser from "../../../preview/ServerBrowser.ts";
import {
  BrowserNavigationTarget,
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPermissionInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshotInput,
  PreviewAutomationSnapshotResult,
  PreviewAutomationExtractInput,
  PreviewAutomationStatus,
  PreviewAutomationTabSummary,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
  SitePermissionsState,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

/** What a browser action fails with, including the access gate's refusal. */
const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = {
  observation: Schema.optional(PreviewAutomationSnapshotResult),
  toolIcon: Schema.optional(ToolActivityIcon),
  /** Server hosts: the tab the action ran on, read live after it. */
  tab: Schema.optional(PreviewAutomationTabSummary),
};

const PreviewActionResult = Schema.Struct({
  ...presentationFields,
  clicked: Schema.optional(Schema.String),
  strategy: Schema.optional(Schema.String),
  dialog: Schema.optional(Schema.Struct({ type: Schema.String, message: Schema.String })),
}).annotate({
  description: "The preview action completed successfully.",
});

/** Drives the real browser and can destroy page state. */
const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

/** Same open-world browser access, but the action does not destroy page state. */
const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A safe browser action that only observes, so it is also repeatable. */
const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const BrowserCookieSourcesTool = Tool.make("browser_cookie_sources", {
  description:
    "List browsers and source profiles found on this environment's own machine. Cookie values are never returned. Imports stay on this machine, including on Linux servers.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(BrowserImportSource),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, ServerBrowser.ServerBrowser],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BrowserImportCookiesTool = Tool.make("browser_import_cookies", {
  description:
    "Reuse the owner's local browser sign-ins in a persistent Cogenly server-browser profile. Import only the domains needed for the task. Use browser_cookie_sources to choose sourceId and sourceProfileDirectory; dryRun previews counts. macOS may prompt for Keychain access; Safari needs Full Disk Access. Cookies never leave this environment or enter the vault. Open preview tabs with profileId set to the returned targetProfileId, then reload existing tabs to use the sign-ins. The desktop this server launched also receives them over local inherited pipes. No extra owner approval is needed.",
  parameters: Schema.Struct({
    ...BrowserCookieImportInput.fields,
    domains: Schema.Array(CookieDomain).check(Schema.isMinLength(1)),
  }),
  success: BrowserCookieImportResult,
  failure: Schema.Union([BrowserCookieImportError, OrchestratorMcpFailure]),
  dependencies: [...dependencies, ServerBrowser.ServerBrowser],
}).annotate(Tool.Destructive, false);

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether a collaborative browser tab is automation-capable, including its control owner, pending dialog, URL, title, profile, visibility, loading state, viewport mode, and measured CSS-pixel size. Visibility is advisory: never stop or ask the user to bring the panel into view because a tab reports visible=false. A notice or sessionMismatch=true means the tab is not the page the user sees or does not share their logins; read it before reporting what the page shows. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. In the desktop app, sitePermissions lists the page's site permissions and a prompt waiting on the user (use preview_permission or ask the user to click Allow). Server hosts also list every tab in the thread (tabs) with its owner, including tabs the user opened, and the browser profiles preview_open accepts. You can read any listed tab. You can act on your own tabs and on tabs the user opened; acting on a tab whose owner is human takes control from the user, so read their tab first and act on it only when the task calls for it.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab and show it in the thread's browser panel, selected, in the user's profile so it shares their logins. In the desktop app every agent tab opens visibly in the panel; open=false only keeps other clients from bringing it forward. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. Parallel subagents sharing a provider session must each open with reuseExistingTab=false and pass their returned tabId on every call. Pass profileId (an id or name from preview_status profiles) to open under a browser profile and its saved logins; omit it for the user's default profile. Another agent session's tabs can be read but not operated.",
    parameters: PreviewAutomationOpenInput.mapFields(
      (fields) => ({
        ...fields,
        url: fields.url.annotate({
          description:
            "Optional initial page URL. Use an absolute http(s) URL or a host such as example.com or localhost:5173. Public hosts use https; loopback hosts use http. Omit for a blank tab.",
        }),
      }),
      { unsafePreserveChecks: true },
    ),
    success: Schema.Struct({ ...PreviewAutomationStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the server browser dialog reported by preview_status. For a prompt, supply promptText when accepting. Works on this agent's own tabs and on tabs the user opened, taking control from the user if they are driving. Desktop hosts may not support this operation.",
    parameters: PreviewAutomationDialogInput,
    success: Schema.Struct({ ...PreviewAutomationStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://example.com'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationNavigateInput.mapFields(
      (fields) => ({
        ...fields,
        url: fields.url.annotate({
          description:
            "Website URL. Use an absolute http(s) URL or a host such as example.com or localhost:5173. Public hosts use https; loopback hosts use http.",
        }),
        target: Schema.optional(
          Schema.Union([
            BrowserNavigationTarget.members[0].mapFields((target) => ({
              ...target,
              url: target.url.annotate({
                description:
                  "Direct website URL, for example https://example.com or localhost:5173.",
              }),
            })),
            BrowserNavigationTarget.members[1],
          ]),
        ).annotate({
          description:
            "Environment-relative target. Use {kind:'environment-port',port:5173} for a dev server in this environment.",
        }),
      }),
      { unsafePreserveChecks: true },
    ),
    success: Schema.Struct({ ...PreviewAutomationStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

const PreviewPermissionTool = safeBrowserTool(
  Tool.make("preview_permission", {
    description:
      "Allow, block, or reset (ask) one site permission for a site in a collaborative browser tab, optionally selected by tabId, so a page that needs the camera, microphone, location, notifications, clipboard read, or MIDI works without waiting for the user to click Allow. Camera and microphone are separate permissions. Use it when preview_status or preview_snapshot reports a page waiting on a permission prompt, or when a page reports permission denied. Omit origin to decide for the origin the tab shows. You can decide for a site the user has not decided on, and your allow answers a prompt that is waiting; you cannot override a site the user explicitly blocked, and the call says so. In the headless server browser a site you allow gets a synthetic camera and microphone, and block behaves like ask (the page is denied). Returns the site's permissions afterward.",
    parameters: PreviewAutomationPermissionInput,
    success: Schema.Struct({ ...SitePermissionsState.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set site permission")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a collaborative browser tab without taking control. Defaults to compact JSON elements with stable refs, roles, names, values, and states in the viewport. Target refs with locator=aria-ref=<ref>; refs survive snapshots but expire on navigation or control handoff. Use scope for a selector/ref subtree and viewportOnly=false for the document. output=full returns the accessibility tree and diagnostics; output=none skips inspection. output=changes compares with the last compact view in this session and scope, or returns the current view if no baseline exists. Diffs over about 1,000 tokens return only counts (summary), URL, title and errors; call preview_snapshot for the details. Use preview_extract for data and preview_evaluate for custom JSON. No screenshot is captured unless includeImage=true or save=true. Request includeImage=true for visual checks, canvas, images, or an empty/ambiguous structured view. Images are downscaled JPEG; save=true writes a PNG and returns screenshotPath for embedding in replies. Screenshot failure returns screenshotError alongside structured data. Pass tabId to read a particular tab, including the user's tab.",
    parameters: PreviewAutomationSnapshotInput,
    success: PreviewAutomationSnapshotResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together. Set button=right for a context menu or clickCount=2 for a double-click; server browser tabs only. Returns what was clicked and its strategy, plus changes by default. Checkbox/radio clicks fall back to the input click only if their state did not change. CSS selector lists are supported; snapshot aria-ref and role/text locators must be used individually. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewHoverTool = safeBrowserTool(
  Tool.make("preview_hover", {
    description:
      "Move the mouse over exactly one target in the tab selected by tabId, or this agent session's current tab when omitted, to reveal hover menus and tooltips. Server browser tabs only. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationHoverInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Hover preview page"),
);

const PreviewSelectTool = browserTool(
  Tool.make("preview_select", {
    description:
      "Choose options in one native <select> in the tab selected by tabId, or this agent session's current tab when omitted, by option value or visible label. Custom dropdowns are not <select>; click them open and click the option instead. Server browser tabs only. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationSelectInput,
    success: Schema.Struct({
      ...PreviewAutomationSelectResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Select preview option"),
);

const PreviewDragTool = browserTool(
  Tool.make("preview_drag", {
    description:
      "Drag one element onto another in the tab selected by tabId, or this agent session's current tab when omitted. Server browser tabs only. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Drag in preview page"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Give files on the environment to the page in the tab selected by tabId, or this agent session's current tab when omitted. After clicking an upload control, preview_status reports the open fileChooser; call this with absolute paths to answer it, or with an empty list to cancel. Pass a locator for an <input type=file> to set its files without a picker. Server browser tabs only. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewExtractTool = browserTool(
  Tool.make("preview_extract", {
    description:
      "Extract bounded JSON data by CSS selector without a snapshot or screenshot. Returns {value:{items,total,omitted}} with visible text and requested attributes. Use compact snapshots to find action refs; use extraction for lists, links, tables, and labels. Takes control like evaluate and is disabled after vault_fill. Use preview_evaluate for custom queries or a custom JSON shape.",
    parameters: PreviewAutomationExtractInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Extract browser data"),
);

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Acts like clicking: it works on your own tabs and on the user's tabs, and takes control from the user if they are driving. To read a tab without taking control, use preview_snapshot. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state. Evaluation is disabled for the lifetime of a tab after vault_fill; use snapshots and focused actions there.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match. Returns changes by default; output selects detail. Screenshots: preview_snapshot includeImage=true.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and transfer the compressed recording once (up to 50 MiB) to an evidence file readable in this agent's environment. Returns its environment-local path after transfer succeeds.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  BrowserCookieSourcesTool,
  BrowserImportCookiesTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewPermissionTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewExtractTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  BrowserCookieSourcesTool,
  BrowserImportCookiesTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewPermissionTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewExtractTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);

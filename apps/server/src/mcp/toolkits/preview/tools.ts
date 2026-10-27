import {
  BrowserCookieImportInput,
  BrowserCookieImportResult,
  BrowserCookieImportError,
  BrowserImportSource,
  CookieDomain,
  BrowserExtension,
  BrowserExtensionError,
  BrowserExtensionId,
  BrowserExtensionInstallInput,
  BrowserExtensionInstallResult,
  BrowserExtensionPage,
  BrowserExtensionRemoveInput,
  BrowserExtensionToggleInput,
  BrowserExtensionsListInput,
  BrowserExtensionsListResult,
  BrowserProfileId,
  PreviewTabId,
} from "@cogenly/contracts";
import * as BrowserExtensions from "../../../preview/BrowserExtensions.ts";
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
    "List this machine's browsers/source profiles. Never returns cookie values; imports stay on this machine.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(BrowserImportSource),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, ServerBrowser.ServerBrowser],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BrowserImportCookiesTool = Tool.make("browser_import_cookies", {
  description:
    "Import needed domains from browser_cookie_sources into a persistent local profile; dryRun returns counts. macOS may need Keychain/Full Disk Access (Safari). Values stay on this machine, outside vault. Open with returned targetProfileId; reload existing tabs to apply. Same-machine desktop receives cookies privately. No extra approval.",
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
    "Read automation health, tab owners/dialogs/permissions, URLs/profiles, viewport and all thread tabs. automation.connected/state determine readiness; visible is advisory. Preserve tabs through reconnect. Read notice/sessionMismatch before reporting. Omitted tabId uses your tab or the user's visible tab. profiles feed preview_open; permissions use preview_permission.",
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
      "Open/show a tab in the default user profile or profileId. Waits for usable automation; failure returns tabId to retry. open:false keeps background state for later display. tabId reuses one; reuseExistingTab:false creates another (required for parallel subagents sharing a session; keep their returned IDs). Other agent sessions' tabs are read-only.",
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
      "Accept/dismiss a server-tab dialog; promptText answers accepted prompts. May take control of user tabs. Desktop support varies.",
    parameters: PreviewAutomationDialogInput,
    success: Schema.Struct({ ...PreviewAutomationStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate tabId using exactly one of url or target:{kind:'environment-port',port:5173}. Returns changes; output selects detail.",
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
      "Change CSS viewport, preserving desktop user agent: mode:fill, freeform+width/height, or preset+preset/orientation. tabId optional.",
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
      "Emulate dark/light prefers-color-scheme; system clears override and follows OS. tabId optional.",
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
      "Allow/block/reset (ask) site permission; origin defaults to tab. Camera/mic are separate. Answers waiting prompts but cannot override explicit user blocks. Headless allowed camera/mic are synthetic; block behaves like ask (denied). Returns permissions.",
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
      "Read without control; default compact viewport refs use locator=aria-ref=<ref>, expiring on navigation/handoff. Cancelled by new input: retry same tab, login/connection intact. changes compares same session/scope baseline; large diffs return counts/URL/title/errors only. full adds tree/diagnostics, none skips inspection. includeImage:true captures JPEG; save:true writes reply PNG. screenshotError preserves structured results. tabId includes user tabs.",
    parameters: PreviewAutomationSnapshotInput,
    success: PreviewAutomationSnapshotResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click one locator (preferred), legacy CSS selector or x+y. button:right/clickCount:2 work on server tabs. Checkbox/radio fallback clicks only if state did not change. CSS lists allowed; aria-ref/role/text locators must be individual. Returns target/strategy and changes.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Type literal text in one input; clear:true replaces it. Prefer locator. Returns changes; output controls inspection.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewHoverTool = safeBrowserTool(
  Tool.make("preview_hover", {
    description: "Hover one target to reveal menus/tooltips (server tabs only). Returns changes.",
    parameters: PreviewAutomationHoverInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Hover preview page"),
);

const PreviewSelectTool = browserTool(
  Tool.make("preview_select", {
    description:
      "Select native <select> options by value or label (server tabs only). For custom dropdowns click open then click an option. Returns changes.",
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
    description: "Drag one element onto another (server tabs only). Returns changes.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Drag in preview page"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Supply environment-local absolute files to an open fileChooser, or [] to cancel. locator targets <input type=file> directly. Server tabs only; returns changes.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description: "Press a key with optional modifiers, e.g. Enter or a + Meta. Returns changes.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll; positive deltaY goes down, deltaX right. locator/selector targets a container. Returns changes.",
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
      "Extract bounded CSS-selected JSON {value:{items,total,omitted}} with visible text/attributes. Use snapshots for action refs. Takes control like evaluate; disabled after vault_fill.",
    parameters: PreviewAutomationExtractInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Extract browser data"),
);

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JavaScript and return serializable {value} up to 64KB; may mutate page and takes control. For passive reads use snapshot. Disabled for the tab lifetime after vault_fill.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until every supplied locator/selector/text/URL condition matches. Returns changes.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording tabId, defaulting to your current tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording and transfer once (max 50MiB). Returns an environment-local evidence path after transfer succeeds.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

const extensionDependencies = [...dependencies, BrowserExtensions.BrowserExtensions];
const BrowserExtensionsListTool = Tool.make("browser_extensions_list", {
  description:
    "List profile extensions with versions, enabled state, sources, permissions/sites and popup/options pages, and loadError from the last load (no Chrome launch). Default profile is the user's. A profile with enabled extensions opens new tabs in Cogenly's full Chrome (all APIs, streamed into the desktop panel, separate storage); existing native desktop tabs stay put and native tabs return once none are enabled. Incognito and isolated tabs lack extensions. Changes restart and close profile server tabs. Reinstall an unpacked folder to pick up rebuilt files.",
  parameters: BrowserExtensionsListInput,
  success: BrowserExtensionsListResult,
  failure: Schema.Union([BrowserExtensionError, OrchestratorMcpFailure]),
  dependencies: extensionDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const BrowserExtensionInstallTool = Tool.make("browser_extension_install", {
  description:
    "Install/update an enabled extension from a verified Chrome Web Store URL/32-letter ID or local unpacked absolute path. Other remote sources refused. Returns loadError if Chrome fails to load it; browsing continues without it. Extensions can access pages with vault fills; install only needed ones. Use browser_extensions_list for access/platform support; changes restart profile server tabs. No extra approval.",
  parameters: BrowserExtensionInstallInput,
  success: BrowserExtensionInstallResult,
  failure: Schema.Union([BrowserExtensionError, OrchestratorMcpFailure]),
  dependencies: extensionDependencies,
})
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

const BrowserExtensionToggleTool = Tool.make("browser_extension_toggle", {
  description:
    "Enable/disable a profile extension, retaining data. Restarts profile server tabs, closing them.",
  parameters: BrowserExtensionToggleInput,
  success: BrowserExtension,
  failure: Schema.Union([BrowserExtensionError, OrchestratorMcpFailure]),
  dependencies: extensionDependencies,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const BrowserExtensionRemoveTool = Tool.make("browser_extension_remove", {
  description:
    "Uninstall/delete a profile extension; returns remaining extensions. Restarts and closes profile server tabs.",
  parameters: BrowserExtensionRemoveInput,
  success: BrowserExtensionsListResult,
  failure: Schema.Union([BrowserExtensionError, OrchestratorMcpFailure]),
  dependencies: extensionDependencies,
}).annotate(Tool.Destructive, true);

const BrowserExtensionOpenTool = browserTool(
  Tool.make("browser_extension_open", {
    description:
      "Open installed popup/options or a relative extension path in its profile, then use preview actions. No-popup code-only toolbar actions cannot be clicked. Popup-as-tab sees itself as active, so keep target pages in another tab. Snapshot content-script effects in the same profile. open:false stays background; tabId reuses a profile tab. See browser_extensions_list for platform limits.",
    parameters: Schema.Struct({
      id: BrowserExtensionId,
      page: BrowserExtensionPage,
      profileId: Schema.optional(BrowserProfileId),
      open: Schema.optional(Schema.Boolean),
      tabId: Schema.optional(PreviewTabId),
    }),
    success: Schema.Struct({ ...PreviewAutomationStatus.fields, ...presentationFields }),
    failure: Schema.Union([BrowserExtensionError, PreviewToolFailure]),
    dependencies: extensionDependencies,
  }).annotate(Tool.Title, "Open extension page"),
);

const extensionTools = [
  BrowserExtensionsListTool,
  BrowserExtensionInstallTool,
  BrowserExtensionToggleTool,
  BrowserExtensionRemoveTool,
  BrowserExtensionOpenTool,
] as const;

export const PreviewToolkit = Toolkit.make(
  BrowserCookieSourcesTool,
  BrowserImportCookiesTool,
  ...extensionTools,
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
  ...extensionTools,
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

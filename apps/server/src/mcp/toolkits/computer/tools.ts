import {
  ComputerToolActionResult,
  ComputerToolAppsResult,
  ComputerToolClickInput,
  ComputerToolDragInput,
  ComputerToolKeyInput,
  ComputerToolOpenAppInput,
  ComputerToolPressInput,
  ComputerToolScreenshotInput,
  ComputerToolScreenshotResult,
  ComputerToolScrollInput,
  ComputerToolTypeInput,
  ComputerToolUiInput,
  ComputerToolUiResult,
  ComputerUseStatus,
  ComputerUseUnavailableError,
  OrchestratorMcpFailure,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUseService.ComputerUse,
];

/** What a computer tool fails with, including the access gate's refusal. */
const ComputerToolFailure = Schema.Union([ComputerUseUnavailableError, OrchestratorMcpFailure]);

const ComputerStatusTool = Tool.make("computer_status", {
  description:
    "Read macOS control availability, owner setting, Accessibility/Screen Recording grants and repair steps. Recheck after permission changes and before reporting failure.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    tool: Schema.optional(
      Schema.String.annotate({
        description:
          "The computer_* tool you are about to use. The report then covers only the permission it needs.",
      }),
    ),
  }),
  success: ComputerUseStatus,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Computer use status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "Screenshot a Mac display in screen points: pixel x/y maps to display.x+x/display.y+y. Prefer computer_ui for controls.",
  parameters: ComputerToolScreenshotInput,
  success: ComputerToolScreenshotResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot screen")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerAppsTool = Tool.make("computer_apps", {
  description:
    "List the apps running on this Mac with their exact names and bundle ids, and which one is in front.",
  parameters: Schema.Struct({
    name: Schema.optional(
      Schema.String.annotate({ description: "Only apps whose name contains this text." }),
    ),
  }),
  success: ComputerToolAppsResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List apps")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerUiTool = Tool.make("computer_ui", {
  description:
    "Read front-window accessibility controls, values/actions, paths and centers. Use paths with computer_press or centers with computer_click; re-read after changes.",
  parameters: ComputerToolUiInput,
  success: ComputerToolUiResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read app controls")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerOpenAppTool = Tool.make("computer_open_app", {
  description: "Launch an app on this Mac, or bring it to the front if it is running.",
  parameters: ComputerToolOpenAppInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerPressTool = Tool.make("computer_press", {
  description:
    "Invoke a computer_ui control's accessibility action (default AXPress). Prefer it over coordinates when supported.",
  parameters: ComputerToolPressInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Press control")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerClickTool = Tool.make("computer_click", {
  description:
    "Click at a screen point. The point comes from computer_ui (x, y) or computer_screenshot.",
  parameters: ComputerToolClickInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Click")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerTypeTool = Tool.make("computer_type", {
  description: "Type text into whatever has keyboard focus. Click or press the field first.",
  parameters: ComputerToolTypeInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Type text")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerKeyTool = Tool.make("computer_key", {
  description: "Press one key or shortcut, such as return, escape, tab, cmd+, or cmd+shift+t.",
  parameters: ComputerToolKeyInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Press key")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerScrollTool = Tool.make("computer_scroll", {
  description: "Scroll at a screen point by lines.",
  parameters: ComputerToolScrollInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Scroll")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerDragTool = Tool.make("computer_drag", {
  description: "Drag with the left button from one screen point to another.",
  parameters: ComputerToolDragInput,
  success: ComputerToolActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Drag")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerAppsTool,
  ComputerUiTool,
  ComputerOpenAppTool,
  ComputerPressTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerScrollTool,
  ComputerDragTool,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerAppsTool,
  ComputerUiTool,
  ComputerOpenAppTool,
  ComputerPressTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerScrollTool,
  ComputerDragTool,
  ComputerScreenshotTool,
);

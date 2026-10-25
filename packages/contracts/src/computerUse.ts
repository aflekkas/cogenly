import * as Schema from "effect/Schema";

/**
 * Computer use: agents driving the Mac's own apps (screenshots, clicks,
 * typing, the accessibility tree) through the `computer_*` MCP tools. The
 * environment server runs every action on its own machine, so availability
 * and permissions describe that machine, not the client a user looks at.
 */

/** The two macOS privacy grants computer use needs. Nothing else is asked for. */
export const ComputerUsePermission = Schema.Literals(["accessibility", "screen-recording"]);
export type ComputerUsePermission = typeof ComputerUsePermission.Type;

export const COMPUTER_USE_PERMISSIONS: ReadonlyArray<ComputerUsePermission> = [
  "accessibility",
  "screen-recording",
];

export const COMPUTER_USE_PERMISSION_TITLES: Record<ComputerUsePermission, string> = {
  accessibility: "Accessibility",
  "screen-recording": "Screen Recording",
};

/** The exact System Settings pane for each grant. */
export const COMPUTER_USE_PERMISSION_SETTINGS_URLS: Record<ComputerUsePermission, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** `unknown` when the probe could not run; it is never treated as granted. */
export const ComputerUsePermissionGrant = Schema.Literals(["granted", "missing", "unknown"]);
export type ComputerUsePermissionGrant = typeof ComputerUsePermissionGrant.Type;

export const ComputerUsePermissionStatus = Schema.Struct({
  permission: ComputerUsePermission,
  grant: ComputerUsePermissionGrant,
  title: Schema.String,
  /** What the grant unlocks, in the user's words. */
  neededFor: Schema.String,
  settingsUrl: Schema.String,
});
export type ComputerUsePermissionStatus = typeof ComputerUsePermissionStatus.Type;

/**
 * - `ready`: the tools work now.
 * - `needs-permission`: macOS has not granted one or both permissions yet.
 * - `disabled`: the owner turned computer use off (machine or project).
 * - `unsupported`: this machine cannot do computer use at all (Linux, a VPS).
 */
export const ComputerUseState = Schema.Literals([
  "ready",
  "needs-permission",
  "disabled",
  "unsupported",
]);
export type ComputerUseState = typeof ComputerUseState.Type;

export const ComputerUseStatus = Schema.Struct({
  state: ComputerUseState,
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
  /** `process.platform` of the environment server. */
  platform: Schema.String,
  /** Why the state is not `ready`, written for the agent to relay. */
  reason: Schema.optional(Schema.String),
  /**
   * The app macOS attributes the grants to: Cogenly when the desktop app runs
   * the server, otherwise the terminal that started it. Null off macOS.
   */
  hostApp: Schema.NullOr(Schema.String),
  permissions: Schema.Array(ComputerUsePermissionStatus),
  nextSteps: Schema.Array(Schema.String),
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseRequestPermissionInput = Schema.Struct({
  permission: ComputerUsePermission,
});
export type ComputerUseRequestPermissionInput = typeof ComputerUseRequestPermissionInput.Type;

export class ComputerUseUnavailableError extends Schema.TaggedError<ComputerUseUnavailableError>()(
  "ComputerUseUnavailableError",
  {
    code: Schema.Literals(["disabled", "unsupported", "permission-missing", "failed"]),
    reason: Schema.String,
    /** Set for `permission-missing`: the grants the user still has to give. */
    missing: Schema.optional(Schema.Array(ComputerUsePermission)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

// ---------------------------------------------------------------------------
// MCP tool inputs and results
// ---------------------------------------------------------------------------

const Coordinate = Schema.Number.annotate({
  description: "Screen point, the same units as computer_screenshot and computer_ui positions.",
});

const AppSelector = Schema.optional(
  Schema.String.annotate({
    description:
      "App name (e.g. 'Dia', 'System Settings') or bundle id. Omit for the frontmost app.",
  }),
);

export const ComputerToolScreenshotInput = Schema.Struct({
  display: Schema.optional(
    Schema.Int.annotate({
      description: "1-based display number from a previous result. Defaults to the main display.",
    }),
  ),
  includeImage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Defaults to true. Pass false for only the metadata.",
    }),
  ),
});
export type ComputerToolScreenshotInput = typeof ComputerToolScreenshotInput.Type;

export const ComputerDisplay = Schema.Struct({
  display: Schema.Int,
  /** Top-left of the display in global screen points. */
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ComputerDisplay = typeof ComputerDisplay.Type;

export const ComputerToolScreenshotResult = Schema.Struct({
  display: ComputerDisplay,
  displays: Schema.Array(ComputerDisplay),
  frontmostApp: Schema.NullOr(Schema.String),
  /** Scaled to the display's size in points: image pixel (x, y) is screen point (display.x + x, display.y + y). */
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type ComputerToolScreenshotResult = typeof ComputerToolScreenshotResult.Type;

export const ComputerApp = Schema.Struct({
  name: Schema.String,
  bundleId: Schema.NullOr(Schema.String),
  pid: Schema.Int,
  frontmost: Schema.Boolean,
  hidden: Schema.Boolean,
});
export type ComputerApp = typeof ComputerApp.Type;

export const ComputerToolAppsResult = Schema.Struct({
  frontmostApp: Schema.NullOr(Schema.String),
  apps: Schema.Array(ComputerApp),
});
export type ComputerToolAppsResult = typeof ComputerToolAppsResult.Type;

export const ComputerToolOpenAppInput = Schema.Struct({
  app: Schema.String.annotate({
    description:
      "App name (e.g. 'Dia') or bundle id. Launches it if needed and brings it to the front.",
  }),
});
export type ComputerToolOpenAppInput = typeof ComputerToolOpenAppInput.Type;

export const ComputerToolUiInput = Schema.Struct({
  app: AppSelector,
  maxDepth: Schema.optional(
    Schema.Int.annotate({ description: "How deep to walk the tree. Defaults to 12." }),
  ),
  maxElements: Schema.optional(
    Schema.Int.annotate({ description: "Stop after this many elements. Defaults to 400." }),
  ),
});
export type ComputerToolUiInput = typeof ComputerToolUiInput.Type;

export const ComputerUiElement = Schema.Struct({
  /** Pass to computer_press. Valid until the window's layout changes. */
  path: Schema.String,
  depth: Schema.Int,
  role: Schema.String,
  title: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Center in screen points, for computer_click when an element has no actions. */
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
  actions: Schema.optional(Schema.Array(Schema.String)),
});
export type ComputerUiElement = typeof ComputerUiElement.Type;

export const ComputerToolUiResult = Schema.Struct({
  app: Schema.String,
  window: Schema.NullOr(Schema.String),
  elements: Schema.Array(ComputerUiElement),
  truncated: Schema.Boolean,
});
export type ComputerToolUiResult = typeof ComputerToolUiResult.Type;

export const ComputerToolPressInput = Schema.Struct({
  app: AppSelector,
  path: Schema.String.annotate({ description: "Element path from computer_ui." }),
  action: Schema.optional(
    Schema.String.annotate({
      description: "Accessibility action from the element's actions. Defaults to AXPress.",
    }),
  ),
});
export type ComputerToolPressInput = typeof ComputerToolPressInput.Type;

export const ComputerToolClickInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  button: Schema.optional(Schema.Literals(["left", "right"])),
  count: Schema.optional(
    Schema.Int.annotate({ description: "2 for a double click. Defaults to 1." }),
  ),
});
export type ComputerToolClickInput = typeof ComputerToolClickInput.Type;

export const ComputerToolTypeInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Typed into whatever has keyboard focus." }),
});
export type ComputerToolTypeInput = typeof ComputerToolTypeInput.Type;

export const ComputerToolKeyInput = Schema.Struct({
  key: Schema.String.annotate({
    description:
      "One key with optional modifiers joined by '+', e.g. 'return', 'escape', 'tab', 'cmd+,', 'cmd+shift+t', 'down'.",
  }),
});
export type ComputerToolKeyInput = typeof ComputerToolKeyInput.Type;

export const ComputerToolScrollInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  dy: Schema.Int.annotate({ description: "Lines to scroll; positive scrolls down." }),
  dx: Schema.optional(
    Schema.Int.annotate({ description: "Lines to scroll; positive scrolls right." }),
  ),
});
export type ComputerToolScrollInput = typeof ComputerToolScrollInput.Type;

export const ComputerToolDragInput = Schema.Struct({
  fromX: Coordinate,
  fromY: Coordinate,
  toX: Coordinate,
  toY: Coordinate,
});
export type ComputerToolDragInput = typeof ComputerToolDragInput.Type;

/** What every action returns, so the thread's activity names the app it touched. */
export const ComputerToolActionResult = Schema.Struct({
  frontmostApp: Schema.NullOr(Schema.String),
});
export type ComputerToolActionResult = typeof ComputerToolActionResult.Type;

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_KIT_GUIDE,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_STATE_GUIDE,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VisualState from "../../../htmlRender/VisualState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
  description: "A complete, self-contained HTML document.",
});

const Kit = Schema.optional(
  Schema.Boolean.annotate({
    description:
      'Whether to inject the Cogenly kit (default stylesheet and components). Defaults to true; pass false for a fully custom design. <html data-cg="off"> in the page does the same.',
  }),
);

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

export const HtmlPreviewTool = Tool.make("html_preview", {
  description: `Render an HTML page in Cogenly's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. The first preview on a machine can report that Cogenly is still installing its preview browser; call again a minute later. ${PAGE_RULES} The page gets the theme variables, the Cogenly kit and the layout described in html_render.`,
  parameters: Schema.Struct({
    html: Html,
    kit: Kit,
    width: Schema.optional(
      Schema.Int.annotate({
        description: `Viewport width in CSS pixels, 240-1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`,
      }),
    ),
    appearance: Schema.optional(
      Schema.Literals(["dark", "light"]).annotate({
        description: "Theme to preview. Defaults to dark.",
      }),
    ),
  }),
  success: Schema.Struct({
    width: Schema.Int,
    contentHeight: Schema.Int,
    capturedHeight: Schema.Int,
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    missingImages: Schema.optional(Schema.Array(Schema.String)),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Preview HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

// Read-only in the MCP sense: it shows a page in the caller's own thread and
// touches no workspace, so plan mode and read-only sandboxes can use it.
// Open-world, since the page may load remote resources, as in a preview.
const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. Cogenly fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${PAGE_RULES} ${HTML_RENDER_KIT_GUIDE} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE.replaceAll("T3", "Cogenly")} ${HTML_RENDER_STATE_GUIDE.replaceAll("T3", "Cogenly")}`,
  parameters: Schema.Struct({
    html: Html,
    kit: Kit,
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ).annotate({ description: "Short name for the page." }),
    height: Schema.Int.annotate({
      description: `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`,
    }),
    initialState: Schema.optional(Schema.Unknown).annotate({
      description:
        "Optional first JSON document (at most 64KB) for an interactive page built on window.cogenly; stored as the visual's state version 1.",
    }),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
      outline: Schema.optional(Schema.String),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const HtmlVisualState = Schema.Struct({
  renderId: Schema.String,
  title: Schema.String,
  state: Schema.Unknown,
  version: Schema.Int,
  locked: Schema.Boolean,
  updatedAt: Schema.String,
});

const HtmlStateReadTool = Tool.make("html_state_read", {
  description:
    "Read one interactive visual's JSON document in the calling thread, by its html_render result attachmentId. Returns null before the first set. Pass the version back to html_state_write.",
  parameters: Schema.Struct({
    renderId: Schema.String.annotate({
      description: "The html_render result's attachmentId.",
    }),
  }),
  success: Schema.Struct({
    state: Schema.NullOr(HtmlVisualState),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, VisualState.VisualStateService],
})
  .annotate(Tool.Title, "Read visual state")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HtmlStateWriteTool = Tool.make("html_state_write", {
  description:
    "Store one interactive visual's JSON document in the calling thread (at most 64KB), by its html_render result attachmentId, for example to mark its items processed. Pass the version html_state_read returned; a write that lost a race fails, so read again and retry. Fails once the visual is locked.",
  parameters: Schema.Struct({
    renderId: Schema.String.annotate({
      description: "The html_render result's attachmentId.",
    }),
    title: Schema.optional(
      Schema.String.annotate({
        description: "Shown in the agent's turn when the page submits. First write wins.",
      }),
    ),
    state: Schema.Unknown,
    expectedVersion: Schema.Int.annotate({
      description: "The version html_state_read returned (0 before the first set).",
    }),
  }),
  success: Schema.Struct({
    state: HtmlVisualState,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    VisualState.VisualStateService,
  ],
})
  .annotate(Tool.Title, "Write visual state")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const HtmlPreviewToolkit = Toolkit.make(HtmlPreviewTool);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);

export const HtmlStateToolkit = Toolkit.make(HtmlStateReadTool, HtmlStateWriteTool);

export const HtmlToolkit = Toolkit.make(
  HtmlPreviewTool,
  HtmlRenderTool,
  HtmlStateReadTool,
  HtmlStateWriteTool,
);

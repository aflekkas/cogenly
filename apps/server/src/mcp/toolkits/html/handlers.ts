import { OrchestratorMcpFailure, VisualStateError } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as VisualState from "../../../htmlRender/VisualState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  HtmlPreviewToolkit,
  HtmlRenderToolkit,
  HtmlStateToolkit,
  type HtmlToolkit,
} from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
]);

const isVisualStateError = Schema.is(VisualStateError);

// Every HTML render error message is built on the server and tells the agent what to do next.
const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const toVisualStateFailure = (error: VisualStateError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const toWireState = (state: {
  readonly renderId: string;
  readonly title: string;
  readonly state: unknown;
  readonly version: number;
  readonly locked: boolean;
  readonly updatedAt: DateTime.Utc;
}) => ({
  renderId: state.renderId,
  title: state.title,
  state: state.state,
  version: state.version,
  locked: state.locked,
  updatedAt: DateTime.formatIso(state.updatedAt),
});

const handlers = {
  // The headless browser runs on the host and can open local files, so only
  // agents Cogenly launched, which already work on this machine, get it.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { png, ...preview } = yield* htmlRender.preview(input).pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  // The page is stored in the calling thread, so it needs that thread's live run.
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const reference = yield* htmlRender
        .publish({ threadId: thread.threadId, ...input })
        .pipe(
          Effect.mapError((error) =>
            isVisualStateError(error) ? toVisualStateFailure(error) : toFailure(error),
          ),
        );
      return {
        htmlRender: reference,
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
  ),
  html_state_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_state_read");
      const visualStates = yield* VisualState.VisualStateService;
      const state = yield* visualStates
        .get({ threadId: thread.threadId, renderId: input.renderId })
        .pipe(Effect.mapError(toVisualStateFailure));
      return { state: state === null ? null : toWireState(state) };
    }),
  ),
  html_state_write: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_state_write");
      const visualStates = yield* VisualState.VisualStateService;
      const state = yield* visualStates
        .set({
          threadId: thread.threadId,
          renderId: input.renderId,
          ...(input.title === undefined ? {} : { title: input.title }),
          state: input.state,
          expectedVersion: input.expectedVersion,
        })
        .pipe(Effect.mapError(toVisualStateFailure));
      return { state: toWireState(state) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
});

export const layerState = McpToolAccess.toLayer(HtmlStateToolkit, {
  html_state_read: handlers.html_state_read,
  html_state_write: handlers.html_state_write,
});

import { OrchestratorMcpFailure } from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import * as ImageSearchService from "../../../images/ImageSearchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ImageToolkit } from "./tools.ts";

const handlers = {
  // Web images are public data and the call changes nothing, so chat-surface
  // callers may use it alongside every other caller.
  image_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* ImageSearchService.ImageSearchService;
      return yield* service.search(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Image search is unavailable right now. Answer without pictures.",
            }),
        ),
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ImageToolkit.tools>;

export const layer = McpToolAccess.toLayer(ImageToolkit, handlers);

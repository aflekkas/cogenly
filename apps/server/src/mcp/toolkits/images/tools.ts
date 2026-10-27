import { ImageSearchInput, ImageSearchResult, OrchestratorMcpFailure } from "@cogenly/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ImageSearchService from "../../../images/ImageSearchService.ts";

const dependencies = [ImageSearchService.ImageSearchService];

const ImageSearchTool = Tool.make("image_search", {
  description:
    "Find image URLs, thumbnails, dimensions and source pages. Embed relevant results as ![alt](url) with a caption and source link. Use returned URLs only; skip images if none match.",
  parameters: ImageSearchInput,
  success: ImageSearchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Search the web for images")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ImageToolkit = Toolkit.make(ImageSearchTool);

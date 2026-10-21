import { ImageSearchInput, ImageSearchResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ImageSearchService from "../../../images/ImageSearchService.ts";

const dependencies = [ImageSearchService.ImageSearchService];

const ImageSearchTool = Tool.make("image_search", {
  description:
    "Search the web for images of something: use it when the user asks what something looks like, asks for pictures, or the topic is inherently visual (people, places, products, species, designs, UI). Returns direct image URLs with thumbnails, dimensions, titles, and source pages. Embed results inline as markdown `![alt](url)` near the relevant text, each with a short caption and a link to its source page; use only URLs from these results, never invent image URLs, and skip images when no results come back.",
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

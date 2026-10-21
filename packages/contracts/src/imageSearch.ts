import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ImageSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
});
export type ImageSearchInput = typeof ImageSearchInput.Type;

export const ImageSearchResultItem = Schema.Struct({
  /** Direct https URL of the full-size image. */
  url: Schema.String.check(Schema.isMaxLength(4096)),
  /** Direct https URL of a smaller thumbnail, when the backend offers one. */
  thumbnailUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  /** Full-size image dimensions in pixels, when the backend reports them. */
  width: Schema.optional(PositiveInt),
  height: Schema.optional(PositiveInt),
  /** Human-readable title or file name. */
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Page describing the image (attribution, license), for the source link. */
  sourcePageUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ImageSearchResultItem = typeof ImageSearchResultItem.Type;

export const ImageSearchResult = Schema.Struct({
  results: Schema.Array(ImageSearchResultItem),
});
export type ImageSearchResult = typeof ImageSearchResult.Type;

export class ImageSearchError extends Schema.TaggedError<ImageSearchError>()("ImageSearchError", {
  operation: Schema.Literals(["search"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Image search failed.";
  }
}

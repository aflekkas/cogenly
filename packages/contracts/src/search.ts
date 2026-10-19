import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";

export const SearchKind = Schema.Literals(["chat", "work", "agent", "commitment", "project", "pr"]);
export type SearchKind = typeof SearchKind.Type;
export const SearchQueryInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  kinds: Schema.optional(Schema.Array(SearchKind).check(Schema.isMaxLength(6))),
  labelId: Schema.optional(ProjectLabelId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type SearchQueryInput = typeof SearchQueryInput.Type;
export const SearchResult = Schema.Struct({
  kind: SearchKind,
  id: Schema.String,
  threadId: Schema.optional(ThreadId),
  title: Schema.String.check(Schema.isMaxLength(500)),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  matchedAt: Schema.optional(IsoDateTime),
  labelIds: Schema.Array(ProjectLabelId),
});
export const SearchQueryResult = Schema.Struct({ results: Schema.Array(SearchResult) });
export type SearchQueryResult = typeof SearchQueryResult.Type;
export class SearchError extends Schema.TaggedError<SearchError>()("SearchError", {
  operation: Schema.Literals(["query", "authorize"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Global search ${this.operation} failed.`;
  }
}

import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const RepoMcpTrustThreadInput = Schema.Struct({ threadId: ThreadId });
export const RepoMcpTrustPrompt = Schema.Struct({
  id: Schema.String,
  remote: Schema.String,
  decision: Schema.Literals(["pending", "trusted", "denied"]),
  servers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.String,
      args: Schema.Array(Schema.String),
    }),
  ),
});
export type RepoMcpTrustPrompt = typeof RepoMcpTrustPrompt.Type;
export const RepoMcpTrustListResult = Schema.Struct({ prompts: Schema.Array(RepoMcpTrustPrompt) });
export const RepoMcpTrustRespondInput = Schema.Struct({
  threadId: ThreadId,
  id: Schema.String,
  trust: Schema.Boolean,
});
export type RepoMcpTrustRespondInput = typeof RepoMcpTrustRespondInput.Type;
export class RepoMcpTrustError extends Schema.TaggedError<RepoMcpTrustError>()(
  "RepoMcpTrustError",
  {
    reason: Schema.Literals(["storage", "not_found", "repository_unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not check repository MCP trust.";
  }
}

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { redactShortValue } from "../vault/VaultRedactor.ts";

/** Scrub known request credentials before retaining upstream errors or results. */
export const redactUpstream = <A>(value: A, secrets: ReadonlyArray<string>): A =>
  redactShortValue(
    value,
    secrets
      .filter(Boolean)
      .flatMap((secret) => [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
        Buffer.from(secret).toString("base64"),
      ]),
  );

const decodeToolError = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.Literal(true),
    content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
  }),
);

/** A tool failure is an upstream outcome too, even inside a successful RPC response. */
export const toolErrorMessage = (result: unknown): string | undefined => {
  const decoded = decodeToolError(result);
  return Option.isSome(decoded)
    ? decoded.value.content
        .map((block) => block.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500) || "The upstream tool failed."
    : undefined;
};

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      error: Schema.optional(
        Schema.Union([Schema.String, Schema.Struct({ message: Schema.String })]),
      ),
    }),
  ),
);

/** Read JSON-RPC and ordinary HTTP API errors without exposing arbitrary response bodies. */
export const upstreamErrorMessage = (text: string): string | undefined => {
  const decoded = decodeErrorBody(text);
  if (Option.isNone(decoded)) return undefined;
  return (
    decoded.value.message ??
    (typeof decoded.value.error === "string" ? decoded.value.error : decoded.value.error?.message)
  );
};

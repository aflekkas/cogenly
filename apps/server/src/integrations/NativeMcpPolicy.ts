import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const McpList = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);

const decodeMcpList = Schema.decodeUnknownSync(McpList);

/** Keep only names; the CLI response can also contain private headers and environment values. */
export const codexNativeMcpNames = (json: string): ReadonlyArray<string> =>
  decodeMcpList(json)
    .filter((server) => server.enabled)
    .map((server) => server.name);

/** A failed inventory must never start a turn with unchecked native tools. */
class CodexNativeMcpEnumerationError extends Schema.TaggedError<CodexNativeMcpEnumerationError>()(
  "CodexNativeMcpEnumerationError",
  { stage: Schema.Literals(["launch", "thread"]) },
) {
  override get message(): string {
    return "Codex native MCP configuration could not be checked. The turn was stopped to keep native servers, plugins and apps disabled. Check the provider configuration and retry.";
  }
}

export const requireCodexNativeMcpEnumeration = <A, E, R>(
  stage: "launch" | "thread",
  read: Effect.Effect<A, E, R>,
) =>
  read.pipe(
    Effect.catch(() => {
      // CLI errors may contain credentials: expose only this fixed policy failure.
      const error = new CodexNativeMcpEnumerationError({ stage });
      return Effect.logWarning(error.message).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );

/** Codex replaces repeated CLI tables before merging. One table retains every literal name. */
export const codexNativeMcpOffArgs = (names: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
  ...(names.length === 0
    ? []
    : [
        "--config",
        `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`,
      ]),
];

import * as Schema from "effect/Schema";

const McpList = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);

/** Keep only names; the CLI response can also contain private headers and environment values. */
export const codexNativeMcpNames = (json: string): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(McpList)(json)
    .filter((server) => server.enabled)
    .map((server) => server.name);

/** Inline TOML keys preserve names containing dots or quotes. */
export const codexNativeMcpOffArgs = (names: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
  ...names.flatMap((name) => ["--config", `mcp_servers={${JSON.stringify(name)}={enabled=false}}`]),
];

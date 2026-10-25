import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Only entries Claude accepts are passed on: one malformed server in an
// explicit MCP config makes the CLI refuse the whole session.
const StringMap = Schema.Record(Schema.String, Schema.String);
const ClaudeRepoMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal("stdio")),
    command: Schema.NonEmptyString,
    args: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
    env: Schema.optionalKey(StringMap),
  }),
  Schema.Struct({
    type: Schema.Literals(["http", "sse"]),
    url: Schema.NonEmptyString,
    headers: Schema.optionalKey(StringMap),
  }),
]);
export type ClaudeRepoMcpServer = typeof ClaudeRepoMcpServer.Type;

const decodeClaudeMcpJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
);
const decodeClaudeRepoMcpServer = Schema.decodeUnknownOption(ClaudeRepoMcpServer);

/**
 * The project-scope `.mcp.json` servers of the checkout containing `cwd`:
 * every file from the checkout root (the nearest directory holding `.git`)
 * down to `cwd`, the closest file winning a name. Outside a checkout only
 * `cwd` is read. Claude's strict MCP mode ignores these files, so Cogenly
 * passes them in its explicit config: a repo the user opened is trusted, and
 * Claude never asks to approve them. Values stay raw; Claude expands `${VAR}`.
 */
export const readClaudeRepoMcpServers = Effect.fn("readClaudeRepoMcpServers")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
  const start = path.resolve(cwd);
  const dirs: Array<string> = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (yield* exists(path.join(dir, ".git"))) break;
    if (path.dirname(dir) === dir) {
      dirs.splice(1);
      break;
    }
  }
  const servers: Record<string, ClaudeRepoMcpServer> = {};
  for (const dir of dirs.toReversed()) {
    const file = path.join(dir, ".mcp.json");
    const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
    if (text._tag === "None") continue;
    const config = decodeClaudeMcpJson(text.value);
    if (config._tag === "None") {
      yield* Effect.logWarning("Skipping a repo .mcp.json that is not valid MCP config.", { file });
      continue;
    }
    for (const [name, entry] of Object.entries(config.value.mcpServers)) {
      // Cogenly's own server name stays Cogenly's.
      if (name === "cogenly") continue;
      const server = decodeClaudeRepoMcpServer(entry);
      if (server._tag === "None") {
        yield* Effect.logWarning("Skipping a repo MCP server Claude would reject.", { file, name });
        continue;
      }
      servers[name] = server.value;
    }
  }
  return servers;
});

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

/**
 * Turn context naming the provider servers that stay on while native ones are
 * off: the repository's own (part of the project) and administrator-managed
 * ones (outside Cogenly, which cannot turn them off). Undefined when neither.
 */
export const nativeMcpContextLine = (input: {
  readonly repoFile: string;
  readonly repo?: ReadonlyArray<string> | undefined;
  readonly managed?: ReadonlyArray<string> | undefined;
}): string | undefined => {
  const repo = input.repo ?? [];
  const managed = input.managed ?? [];
  const lines = [
    ...(repo.length === 0
      ? []
      : [
          `MCP servers from this repo (${input.repoFile}): ${repo.join(", ")}. They are part of the project; use them for its work.`,
        ]),
    ...(managed.length === 0
      ? []
      : [
          `Administrator-managed MCP servers, not Cogenly integrations: ${managed.join(", ")}. Cogenly cannot turn them off; prefer Cogenly integrations for the same services.`,
        ]),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
};

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

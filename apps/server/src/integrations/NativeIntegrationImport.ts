import {
  IntegrationError,
  IntegrationName,
  type IntegrationCreateInput,
  type IntegrationNativeImportPreview,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parse } from "smol-toml";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown) =>
  Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 40)
    .replace(/^-+/, "") || "server";

/** Mapping deliberately drops secret values. Only definitions and missing-field names leave here. */
export function mapNativeIntegrations(
  claude: unknown,
  codex: unknown,
): IntegrationNativeImportPreview {
  const definitions: IntegrationCreateInput[] = [];
  const reconnect: string[] = [];
  const warnings: string[] = [];
  const add = (provider: string, servers: unknown) => {
    for (const [nativeName, raw] of Object.entries(record(servers))) {
      if (nativeName === "cogenly") continue;
      const server = record(raw);
      if (server.type === "claudeai-proxy") {
        reconnect.push(`claude.ai ${nativeName} (sign in again through Cogenly)`);
        continue;
      }
      const name = IntegrationName.make(`${provider}-${slug(nativeName)}`);
      const refs = (value: unknown) =>
        Object.fromEntries(
          Object.keys(strings(value)).map((key) => [
            key,
            `{{credential:${name}-${slug(key)}.value}}`,
          ]),
        );
      const base = {
        name,
        displayName: nativeName.slice(0, 200),
        enabled: false,
        scope: { type: "all" as const },
        hint: "Imported definition; ask an agent to collect credentials and verify before enabling.",
      };
      if (typeof server.url === "string") {
        const url = URL.parse(server.url);
        if (
          !url ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !["https:", "http:"].includes(url.protocol)
        ) {
          warnings.push(`${name}: URL needs manual review; private URL values were not imported.`);
          continue;
        }
        // Only standard, credential-free paths may leave the native config reader.
        const privateEndpoint = !["/", "/mcp", "/sse"].includes(url.pathname);
        if (privateEndpoint)
          warnings.push(
            `${name}: private endpoint withheld; use request_secret with saveToVault for ${name}-endpoint, field value, allowed domain ${url.hostname}, then verify before enabling.`,
          );
        definitions.push({
          ...base,
          transport: "http",
          url: privateEndpoint ? `${url.origin}/` : url.href,
          ...(privateEndpoint ? { endpointRef: `${name}-endpoint.value` } : {}),
          headers: {
            ...refs(server.headers),
            ...refs(server.http_headers),
            ...(typeof server.bearer_token_env_var === "string"
              ? { Authorization: `Bearer {{credential:${name}-token.value}}` }
              : {}),
          },
        });
      } else if (typeof server.command === "string") {
        // Positional arguments may contain credentials: never copy their values into settings.
        const args =
          Array.isArray(server.args) && server.args.length > 0
            ? ["<reenter-reviewed-arguments>"]
            : [];
        if (args.length > 0)
          warnings.push(
            `${name}: command arguments were withheld; ask an agent to restore non-secret arguments.`,
          );
        definitions.push({
          ...base,
          transport: "stdio",
          url: "https://localhost",
          headers: {},
          command: { command: server.command, args, env: refs(server.env) },
        });
      } else {
        warnings.push(`${name}: unsupported native transport; reconnect with an agent.`);
        continue;
      }
      reconnect.push(name);
    }
  };
  const source = record(claude);
  add("claude", source.mcpServers);
  // Local project definitions retain their project separation by staying disabled until reviewed.
  for (const [project, value] of Object.entries(record(source.projects))) {
    const servers = record(record(value).mcpServers);
    if (Object.keys(servers).length) {
      warnings.push("Claude project MCP definitions need project scope review before enabling.");
      add(`claude-${slug(project.split("/").at(-1) ?? "project")}`, servers);
    }
  }
  add("codex", record(codex).mcp_servers);
  for (const connector of Array.isArray(source.claudeAiMcpServers)
    ? source.claudeAiMcpServers
    : []) {
    const value = record(connector);
    if (typeof value.name === "string")
      reconnect.push(`claude.ai ${value.name.slice(0, 200)} (sign in again through Cogenly)`);
  }
  warnings.push(
    "claude.ai authorization cannot be imported. Its connector directory is account-hosted; ask the user which additional connectors to reconnect if none are listed here.",
  );
  return { definitions, reconnect, warnings };
}

/** `claude mcp list` includes cloud connector names; discard URLs, statuses and diagnostics. */
export function claudeAiConnectorNames(output: string): ReadonlyArray<string> {
  return [
    ...new Set(
      output.split("\n").flatMap((line) => {
        const match = /^\s*(claude\.ai [^:\r\n]{1,200}):/.exec(line);
        return match ? [match[1]!] : [];
      }),
    ),
  ].slice(0, 100);
}

export class NativeIntegrationImport extends Context.Service<
  NativeIntegrationImport,
  {
    readonly preview: Effect.Effect<IntegrationNativeImportPreview, IntegrationError>;
  }
>()("cogenly-server/integrations/NativeIntegrationImport") {}

export const layer = Layer.effect(
  NativeIntegrationImport,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const read = (file: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(file))) return undefined;
        return yield* fs.readFileString(file);
      });
    return NativeIntegrationImport.of({
      preview: Effect.gen(function* () {
        const claude = yield* read(path.join(home, ".claude.json"));
        const codex = yield* read(path.join(home, ".codex", "config.toml"));
        const claudeConfig =
          claude === undefined
            ? {}
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(claude);
        const preview = yield* Effect.try(() =>
          mapNativeIntegrations(claudeConfig, codex === undefined ? {} : parse(codex)),
        );
        const cloud = yield* Effect.gen(function* () {
          const command = yield* resolveSpawnCommand("claude", ["mcp", "list"], {
            env: environment,
          });
          return yield* spawner.string(
            ChildProcess.make(command.command, command.args, {
              cwd: home,
              env: { ...environment, ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
              shell: command.shell,
            }),
          );
        }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.option);
        return {
          ...preview,
          reconnect: [
            ...new Set([
              ...preview.reconnect,
              ...(Option.isSome(cloud)
                ? claudeAiConnectorNames(cloud.value).map(
                    (name) => `${name} (sign in again through Cogenly)`,
                  )
                : []),
            ]),
          ],
          warnings: [
            ...preview.warnings,
            ...(Option.isNone(cloud)
              ? [
                  "Claude connector discovery was unavailable; check claude.ai/customize/connectors for other accounts to reconnect.",
                ]
              : []),
          ],
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new IntegrationError({
              operation: "preview native integration definitions",
              reason: "storage",
              cause,
            }),
        ),
      ),
    });
  }),
);

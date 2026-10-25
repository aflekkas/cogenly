import {
  ClaudeSettings,
  CodexSettings,
  IntegrationError,
  IntegrationName,
  ProviderDriverKind,
  type IntegrationCreateInput,
  type IntegrationNativeImportPreview,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@cogenly/shared/shell";
import * as Option from "effect/Option";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { parse } from "smol-toml";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@cogenly/provider-core/server/instanceEnvironment";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { claudeAccountConfigPath } from "../provider/claudeResetCredits.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const NativeConfig = Schema.Record(Schema.String, Schema.Unknown);
const decodeNativeObject = Schema.decodeUnknownEffect(NativeConfig);
const decodeNativeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeConfig));
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

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
  prefixes = { claude: "claude", codex: "codex" },
): IntegrationNativeImportPreview {
  const definitions: IntegrationCreateInput[] = [];
  const reconnect: string[] = [];
  const warnings: string[] = [];
  let incomplete = false;
  const add = (provider: string, servers: unknown) => {
    if (
      servers !== undefined &&
      (typeof servers !== "object" || servers === null || Array.isArray(servers))
    ) {
      incomplete = true;
      warnings.push(`${provider}: unsupported native server table; review the source manually.`);
    }
    for (const [nativeName, raw] of Object.entries(record(servers))) {
      if (nativeName === "cogenly") continue;
      const server = record(raw);
      if (server.type === "claudeai-proxy") {
        reconnect.push(`claude.ai ${nativeName} (sign in again through Cogenly)`);
        continue;
      }
      const name = IntegrationName.make(`${provider}-${slug(nativeName)}`.slice(0, 64));
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
          incomplete = true;
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
        incomplete = true;
        warnings.push(`${name}: unsupported native transport; reconnect with an agent.`);
        continue;
      }
      reconnect.push(name);
    }
  };
  const source = record(claude);
  add(prefixes.claude, source.mcpServers);
  // Local project definitions retain their project separation by staying disabled until reviewed.
  for (const [project, value] of Object.entries(record(source.projects))) {
    const servers = record(record(value).mcpServers);
    if (Object.keys(servers).length) {
      warnings.push("Claude project MCP definitions need project scope review before enabling.");
      add(`${prefixes.claude}-p${(Hash.string(project) >>> 0).toString(36)}`, servers);
    }
  }
  add(prefixes.codex, record(codex).mcp_servers);
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
  return { definitions, reconnect, warnings, incomplete };
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
    const settings = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    return NativeIntegrationImport.of({
      preview: Effect.gen(function* () {
        const definitions: IntegrationCreateInput[] = [];
        const reconnect: string[] = [];
        const warnings: string[] = [];
        let incomplete = false;
        const unavailable = (source: string) => {
          incomplete = true;
          warnings.push(
            `${source}: source could not be reviewed; resolve it and retry, or explicitly skip the import.`,
          );
        };
        const merge = (preview: IntegrationNativeImportPreview) => {
          incomplete ||= preview.incomplete === true;
          for (const definition of preview.definitions) {
            const previous = definitions.find((item) => item.name === definition.name);
            if (previous === undefined) definitions.push(definition);
            else if (JSON.stringify(previous) !== JSON.stringify(definition))
              unavailable(`${definition.name}: conflicting native definitions`);
          }
          reconnect.push(...preview.reconnect);
          warnings.push(...preview.warnings);
        };
        const read = (file: string, source: string, toml = false) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(file))) return undefined;
            const text = yield* fs.readFileString(file);
            if (toml) {
              const parsed = yield* Effect.try(() => parse(text));
              return yield* decodeNativeObject(parsed);
            }
            return yield* decodeNativeJson(text);
          }).pipe(
            Effect.catch(() => {
              // Parser and filesystem diagnostics can contain native credential values.
              unavailable(source);
              return Effect.succeed(undefined);
            }),
          );
        const configured = yield* settings.getSettings;
        const roots = new Set(
          (yield* projects.listShells().pipe(
            Effect.catch(() => {
              unavailable("Project configuration inventory");
              return Effect.succeed([]);
            }),
          )).map((project) => project.workspaceRoot),
        );
        // Unconfigured built-ins still run; explicit instance entries override their homes.
        const instances = new Map(Object.entries(configured.providerInstances));
        for (const driver of ["claudeAgent", "codex"]) {
          if (!instances.has(driver))
            instances.set(driver, { driver: ProviderDriverKind.make(driver) });
        }
        for (const [id, instance] of instances) {
          if (instance.driver !== "claudeAgent" && instance.driver !== "codex") continue;
          const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
          const prefix = id === "claudeAgent" ? "claude" : slug(id).slice(0, 24);
          if (instance.driver === "claudeAgent") {
            const decoded = yield* decodeClaudeSettings(instance.config ?? {}).pipe(Effect.option);
            if (Option.isNone(decoded)) {
              unavailable(`${id}: provider configuration`);
              continue;
            }
            const config = decoded.value;
            const dir = yield* resolveClaudeHomePath(config, env);
            const cloudEnv = yield* makeClaudeEnvironment(config, env);
            const file = yield* claudeAccountConfigPath(
              config.homePath.trim() || env.CLAUDE_CONFIG_DIR?.trim() ? dir : undefined,
            );
            const native = yield* read(file, `${id}: native user config`);
            if (native === undefined && (config.homePath.trim() || env.CLAUDE_CONFIG_DIR?.trim()))
              unavailable(`${id}: selected native user config is missing or unreadable`);
            if (native === undefined)
              warnings.push(
                `${id}: no readable native user config found in the resolved provider home.`,
              );
            else {
              for (const root of Object.keys(record(native.projects))) roots.add(root);
              merge(mapNativeIntegrations(native, {}, { claude: prefix, codex: prefix }));
            }
            const cloud = yield* Effect.gen(function* () {
              const command = yield* resolveSpawnCommand(
                expandHomePath(config.binaryPath || "claude", home),
                ["mcp", "list"],
                { env },
              );
              return yield* spawner.string(
                ChildProcess.make(command.command, command.args, {
                  cwd: home,
                  env: { ...cloudEnv, ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
                  shell: command.shell,
                }),
              );
            }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.option);
            if (Option.isNone(cloud)) unavailable(`${id}: Claude connector discovery`);
            else
              reconnect.push(
                ...claudeAiConnectorNames(cloud.value).map(
                  (name) => `${name} (sign in again through Cogenly)`,
                ),
              );
          } else {
            const decoded = yield* decodeCodexSettings(instance.config ?? {}).pipe(Effect.option);
            if (Option.isNone(decoded)) {
              unavailable(`${id}: provider configuration`);
              continue;
            }
            const config = decoded.value;
            const layout = yield* resolveCodexHomeLayout({
              ...config,
              homePath:
                config.homePath || (config.setupMode !== "managed" ? (env.CODEX_HOME ?? "") : ""),
            });
            const native = yield* read(
              path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "config.toml"),
              `${id}: native user config`,
              true,
            );
            if (
              native === undefined &&
              (config.homePath.trim() || config.shadowHomePath.trim() || env.CODEX_HOME?.trim())
            )
              unavailable(`${id}: selected native user config is missing or unreadable`);
            if (native === undefined)
              warnings.push(
                `${id}: no readable native user config found in the resolved provider home.`,
              );
            else {
              for (const root of Object.keys(record(native.projects))) roots.add(root);
              if (
                native.project_root_markers !== undefined &&
                (!Array.isArray(native.project_root_markers) ||
                  native.project_root_markers.length !== 1 ||
                  native.project_root_markers[0] !== ".git")
              )
                unavailable(`${id}: custom project root markers are unsupported`);
              merge(mapNativeIntegrations({}, native, { claude: prefix, codex: prefix }));
              if (
                Object.values(record(native.profiles)).some(
                  (profile) => record(profile).mcp_servers !== undefined,
                )
              )
                unavailable(`${id}: profile MCP overrides are unsupported`);
            }
            if (resolveCodexLaunchArgs(config.launchArgs, env))
              unavailable(`${id}: CLI launch overrides are unsupported`);
          }
        }
        // Inventory project layers separately: they stay disabled pending project-scope review.
        // Walk ancestors too, since a CLI may read a repository root above a thread's cwd.
        const visited = new Set<string>();
        for (const root of roots) {
          if (!path.isAbsolute(root)) {
            unavailable("Relative project configuration root");
            continue;
          }
          let dir = path.normalize(root);
          let boundary = dir;
          let ancestor = dir;
          while (true) {
            const isRepository = yield* fs.exists(path.join(ancestor, ".git")).pipe(
              Effect.catch(() => {
                unavailable("Project repository boundary");
                return Effect.succeed(false);
              }),
            );
            if (isRepository) {
              boundary = ancestor;
              break;
            }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
          }
          // Without a repository marker, the CLI treats cwd as its project root.
          // Never mistake an ancestor's user home config for a project layer.
          while (!visited.has(dir)) {
            visited.add(dir);
            const prefix = `project-p${(Hash.string(dir) >>> 0).toString(36)}`;
            const claude = yield* read(
              path.join(dir, ".mcp.json"),
              `${prefix}: Claude project config`,
            );
            const codex = yield* read(
              path.join(dir, ".codex", "config.toml"),
              `${prefix}: Codex project config`,
              true,
            );
            if (claude !== undefined || codex !== undefined) {
              warnings.push(
                "Project MCP definitions need project scope review before enabling; provider trust rules may exclude these layers.",
              );
              merge(
                mapNativeIntegrations(claude ?? {}, codex ?? {}, {
                  claude: `claude-${prefix}`,
                  codex: `codex-${prefix}`,
                }),
              );
            }
            const parent = path.dirname(dir);
            if (dir === boundary || parent === dir) break;
            dir = parent;
          }
        }
        return {
          definitions,
          reconnect: [...new Set(reconnect)],
          warnings: [...new Set(warnings)],
          incomplete,
        };
      }).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.HomeDirectory, home),
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

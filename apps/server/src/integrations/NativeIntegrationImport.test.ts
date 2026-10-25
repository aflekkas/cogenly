import { expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import {
  OrchestrationProjectShell,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as NativeImport from "./NativeIntegrationImport.ts";
import { parse } from "smol-toml";
import { mapNativeIntegrations, claudeAiConnectorNames } from "./NativeIntegrationImport.ts";
it("maps native fixture configs to disconnected definitions and never copies secrets", () => {
  const result = mapNativeIntegrations(
    {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "fixture-secret" },
        },
        local: {
          command: "npx",
          args: ["-y", "package", "--key", "fixture-secret"],
          env: { KEY: "fixture-secret" },
        },
        cogenly: { url: "https://cogenly.example/mcp" },
        signed: { url: "https://example.com/mcp?token=fixture-secret" },
      },
      claudeAiMcpServers: [{ name: "Gmail", token: "fixture-secret" }],
    },
    parse(`
[mcp_servers.tracker]
url = "https://tracker.example/mcp"
[mcp_servers.tracker.http_headers]
Authorization = "fixture-secret"
[mcp_servers.worker]
command = "worker"
[mcp_servers.worker.env]
KEY = "fixture-secret"
`),
  );
  expect(result.definitions.map((definition) => definition.name)).toEqual([
    "claude-remote",
    "claude-local",
    "codex-tracker",
    "codex-worker",
  ]);
  expect(result.definitions.every((definition) => !definition.enabled)).toBe(true);
  expect(result.definitions[0]?.headers.Authorization).toBe(
    "{{credential:claude-remote-authorization.value}}",
  );
  expect(result.definitions[1]?.command?.env.KEY).toBe("{{credential:claude-local-key.value}}");
  expect(result.reconnect).toContain("claude.ai Gmail (sign in again through Cogenly)");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

it("lists claude.ai connector names without copying URLs or account-hosted auth", () => {
  expect(
    claudeAiConnectorNames(
      "Checking MCP server health...\nclaude.ai Gmail: https://example.com?token=fixture-secret - Connected\nlocal: npx server - Connected\nclaude.ai Wispr Flow: https://example.com - Needs authentication\n",
    ),
  ).toEqual(["claude.ai Gmail", "claude.ai Wispr Flow"]);
});

it.effect(
  "previews fixture native files and cloud names without returning their secret values",
  () => {
    const files = new Map([
      [
        "/fixture/.claude.json",
        '{"mcpServers":{"mail":{"type":"http","url":"https://mail.example/mcp","headers":{"Authorization":"fixture-private"}}}}',
      ],
      [
        "/fixture/.codex/config.toml",
        '[mcp_servers.worker]\ncommand="worker"\n[mcp_servers.worker.env]\nKEY="fixture-private"',
      ],
    ]);
    return Effect.gen(function* () {
      const preview = yield* (yield* NativeImport.NativeIntegrationImport).preview;
      expect(preview.definitions.map((definition) => definition.name)).toEqual([
        "claude-mail",
        "codex-worker",
      ]);
      expect(preview.reconnect).toContain("claude.ai Gmail (sign in again through Cogenly)");
      expect(JSON.stringify(preview)).not.toContain("fixture-private");
    }).pipe(
      Effect.provide(
        NativeImport.layer.pipe(
          Layer.provide(NodePath.layer),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          ),
          Layer.provide(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                exists: (path) => Effect.succeed(files.has(path)),
                readFileString: (path) => Effect.succeed(files.get(path) ?? ""),
              }),
            ),
          ),
          Layer.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              string: () =>
                Effect.succeed(
                  "claude.ai Gmail: https://cloud.example?token=fixture-private - Connected\n",
                ),
            }),
          ),
        ),
      ),
      Effect.provideService(HostProcess.HomeDirectory, "/fixture"),
      Effect.provideService(HostProcess.Environment, { PATH: "/fixture/bin" }),
    );
  },
);

it("withholds every nonstandard imported URL path and requests private vault re-entry", () => {
  for (const pathname of [
    "/mcp/fixture-private-capability-6YpA92x",
    "/short-key",
    "/tenant/mcp",
    "/mcp/%66ixture-private",
  ]) {
    const preview = mapNativeIntegrations(
      { mcpServers: { private: { url: `https://example.com${pathname}` } } },
      {},
    );
    expect(JSON.stringify(preview)).not.toContain(pathname);
    expect(preview.definitions[0]).toMatchObject({
      url: "https://example.com/",
      endpointRef: "claude-private-endpoint.value",
      enabled: false,
    });
    expect(preview.warnings.join(" ")).toContain("request_secret");
  }
  for (const pathname of ["/", "/mcp", "/sse"]) {
    const preview = mapNativeIntegrations(
      {},
      { mcp_servers: { safe: { url: `https://example.com${pathname}` } } },
    );
    expect(preview.definitions[0]?.url).toBe(`https://example.com${pathname}`);
  }
});

const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: "fixture-project",
  title: "Fixture",
  workspaceRoot: "/fixture/work/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const fixturePreview = (files: ReadonlyMap<string, string>, broken = false) => {
  const read: string[] = [];
  return Effect.gen(function* () {
    const preview = yield* (yield* NativeImport.NativeIntegrationImport).preview;
    return { preview, read };
  }).pipe(
    Effect.provide(
      NativeImport.layer.pipe(
        Layer.provide(NodePath.layer),
        Layer.provide(
          ServerSettings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "~/claude-profile" },
              },
              [ProviderInstanceId.make("claude-env")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/claude-env" }],
              },
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: {
                  setupMode: "existing",
                  homePath: "~/codex-profile",
                  ...(broken ? { launchArgs: "--config fixture=true" } : {}),
                },
              },
              [ProviderInstanceId.make("codex-env")]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "CODEX_HOME", value: "~/codex-env" }],
                config: { setupMode: "existing" },
              },
            },
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
        ),
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              exists: (file) => Effect.succeed(files.has(file)),
              readFileString: (file) =>
                Effect.sync(() => {
                  read.push(file);
                  return files.get(file) ?? "";
                }),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({ string: () => Effect.succeed("") }),
        ),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/fixture"),
    Effect.provideService(HostProcess.Environment, { PATH: "/fixture/bin" }),
  );
};

it.effect(
  "reads each provider instance home and project configs without falling back to default homes",
  () =>
    Effect.gen(function* () {
      const { preview, read } = yield* fixturePreview(
        new Map([
          ["/fixture/.claude.json", '{"mcpServers":{"decoy":{"url":"https://wrong.example/mcp"}}}'],
          ["/fixture/.codex/config.toml", '[mcp_servers.decoy]\nurl="https://wrong.example/mcp"'],
          [
            "/fixture/claude-profile/.claude.json",
            '{"mcpServers":{"work":{"url":"https://claude-profile.example/mcp"}}}',
          ],
          [
            "/fixture/claude-env/.claude.json",
            '{"mcpServers":{"work":{"url":"https://claude-env.example/mcp"}}}',
          ],
          [
            "/fixture/codex-profile/config.toml",
            '[mcp_servers.work]\nurl="https://codex-profile.example/mcp"',
          ],
          [
            "/fixture/codex-env/config.toml",
            '[mcp_servers.work]\nurl="https://codex-env.example/mcp"',
          ],
          ["/fixture/work/.git", ""],
          [
            "/fixture/work/.codex/config.toml",
            '[mcp_servers.parent]\nurl="https://parent-project.example/mcp"',
          ],
          [
            "/fixture/work/repo/.mcp.json",
            '{"mcpServers":{"project":{"url":"https://claude-project.example/mcp","headers":{"Authorization":"fixture-private"}}}}',
          ],
          [
            "/fixture/work/repo/.codex/config.toml",
            '[mcp_servers.project]\nurl="https://codex-project.example/mcp"',
          ],
        ]),
      );
      expect(read).not.toContain("/fixture/.claude.json");
      expect(read).not.toContain("/fixture/.codex/config.toml");
      for (const source of [
        "claude-profile",
        "claude-env",
        "codex-profile",
        "codex-env",
        "claude-project",
        "codex-project",
        "parent-project",
      ])
        expect(
          preview.definitions.some(
            (definition) => definition.url === `https://${source}.example/mcp`,
          ),
        ).toBe(true);
      expect(new Set(preview.definitions.map((definition) => definition.name)).size).toBe(
        preview.definitions.length,
      );
      expect(preview.incomplete).toBe(false);
      expect(JSON.stringify(preview)).not.toContain("fixture-private");
      expect(preview.definitions.every((definition) => definition.enabled === false)).toBe(true);
    }),
);

it.effect(
  "reports unreadable and unsupported sources as an incomplete review without leaking diagnostics",
  () =>
    Effect.gen(function* () {
      const { preview } = yield* fixturePreview(
        new Map([
          ["/fixture/claude-profile/.claude.json", "invalid fixture-private JSON"],
          ["/fixture/codex-env/config.toml", '[mcp_servers.good]\nurl="https://good.example/mcp"'],
        ]),
        true,
      );
      expect(preview.incomplete).toBe(true);
      expect(preview.warnings.join(" ")).toContain("claudeAgent");
      expect(preview.warnings.join(" ")).toContain("launch");
      expect(
        preview.definitions.some((definition) => definition.url === "https://good.example/mcp"),
      ).toBe(true);
      expect(JSON.stringify(preview)).not.toContain("fixture-private");
    }),
);

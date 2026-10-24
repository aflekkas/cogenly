import { expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

import { expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { ProviderInstanceId, ProviderDriverKind } from "@cogenly/contracts";
import * as ServerSettings from "../serverSettings.ts";
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

it("lists each native server for review with where it came from and what it still needs", () => {
  const result = mapNativeIntegrations(
    {
      mcpServers: {
        docs: { url: "https://docs.example/mcp" },
        keyed: { url: "https://keyed.example/mcp", headers: { Authorization: "fixture-secret" } },
        tool: { command: "tool", args: ["--key", "fixture-secret"] },
        odd: { transport: "carrier-pigeon" },
      },
      claudeAiMcpServers: [{ name: "Slack" }],
    },
    { mcp_servers: { worker: { command: "worker", env: { KEY: "fixture-secret" } } } },
    undefined,
    { claude: "~/.claude.json", codex: "~/.codex/config.toml" },
  );
  expect(result.servers).toEqual([
    { label: "docs", provider: "claude", scope: "user", file: "~/.claude.json", status: "ready" },
    {
      label: "keyed",
      provider: "claude",
      scope: "user",
      file: "~/.claude.json",
      status: "needs-secret",
    },
    {
      label: "tool",
      provider: "claude",
      scope: "user",
      file: "~/.claude.json",
      status: "needs-setup",
    },
    {
      label: "odd",
      provider: "claude",
      scope: "user",
      file: "~/.claude.json",
      status: "unsupported",
    },
    {
      label: "worker",
      provider: "codex",
      scope: "user",
      file: "~/.codex/config.toml",
      status: "needs-secret",
    },
    { label: "Slack", provider: "claude", scope: "account", status: "needs-sign-in" },
  ]);
  expect(JSON.stringify(result.servers)).not.toContain("fixture-secret");
});

it("shows config paths under the home directory as ~", () => {
  expect(NativeImport.nativeConfigDisplayPath("/home/me/.claude.json", "/home/me")).toBe(
    "~/.claude.json",
  );
  expect(NativeImport.nativeConfigDisplayPath("/home/meg/.mcp.json", "/home/me")).toBe(
    "/home/meg/.mcp.json",
  );
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
      expect(preview.servers).toEqual([
        {
          label: "mail",
          provider: "claude",
          scope: "user",
          file: "~/.claude.json",
          status: "needs-secret",
        },
        { label: "Gmail", provider: "claude", scope: "account", status: "needs-sign-in" },
        {
          label: "worker",
          provider: "codex",
          scope: "user",
          file: "~/.codex/config.toml",
          status: "needs-secret",
        },
      ]);
      expect(JSON.stringify(preview)).not.toContain("fixture-private");
    }).pipe(
      Effect.provide(
        NativeImport.layer.pipe(
          Layer.provide(NodePath.layer),
          Layer.provide(ServerSettings.layerTest()),
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
  "reads each provider instance home without falling back to default homes, and leaves repo configs to the checkout",
  () =>
    Effect.gen(function* () {
      const { preview, read } = yield* fixturePreview(
        new Map([
          ["/fixture/.claude.json", '{"mcpServers":{"decoy":{"url":"https://wrong.example/mcp"}}}'],
          ["/fixture/.codex/config.toml", '[mcp_servers.decoy]\nurl="https://wrong.example/mcp"'],
          [
            "/fixture/claude-profile/.claude.json",
            '{"mcpServers":{"work":{"url":"https://claude-profile.example/mcp"}},"projects":{"/fixture/work/repo":{"mcpServers":{"local":{"url":"https://claude-local.example/mcp"}}}}}',
          ],
          [
            "/fixture/claude-env/.claude.json",
            '{"mcpServers":{"work":{"url":"https://claude-env.example/mcp"}}}',
          ],
          [
            "/fixture/codex-profile/config.toml",
            '[mcp_servers.work]\nurl="https://codex-profile.example/mcp"\n[projects."/fixture/work/repo"]\ntrust_level="trusted"',
          ],
          [
            "/fixture/codex-env/config.toml",
            '[mcp_servers.work]\nurl="https://codex-env.example/mcp"',
          ],
          ["/fixture/work/.git", ""],
          [
            "/fixture/work/repo/.mcp.json",
            '{"mcpServers":{"project":{"url":"https://claude-project.example/mcp"}}}',
          ],
          [
            "/fixture/work/repo/.codex/config.toml",
            '[mcp_servers.project]\nurl="https://codex-project.example/mcp"',
          ],
        ]),
      );
      expect(read).not.toContain("/fixture/.claude.json");
      expect(read).not.toContain("/fixture/.codex/config.toml");
      // Checked-in servers load with the repo; importing them would sync them without it.
      expect(read).not.toContain("/fixture/work/repo/.mcp.json");
      expect(read).not.toContain("/fixture/work/repo/.codex/config.toml");
      expect(preview.definitions.map((definition) => definition.url).sort()).toEqual(
        ["claude-profile", "claude-env", "codex-profile", "codex-env", "claude-local"]
          .map((source) => `https://${source}.example/mcp`)
          .sort(),
      );
      expect(new Set(preview.definitions.map((definition) => definition.name)).size).toBe(
        preview.definitions.length,
      );
      expect(preview.incomplete).toBe(false);
      // A user's private per-project Claude entry lives outside the repo, so it is imported.
      expect(preview.servers).toContainEqual({
        label: "local",
        provider: "claude",
        scope: "project",
        file: "~/claude-profile/.claude.json",
        status: "ready",
      });
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

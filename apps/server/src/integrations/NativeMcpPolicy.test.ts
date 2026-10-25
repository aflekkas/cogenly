// @effect-diagnostics-next-line nodeBuiltinImport:off -- An installed CLI is exercised only against a synthetic temporary home.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Isolated on-disk CLI fixtures, never user config.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import {
  codexNativeMcpNames,
  codexNativeMcpOffArgs,
  requireCodexNativeMcpEnumeration,
} from "./NativeMcpPolicy.ts";
it("suppresses all native MCPs from CLI output, including stdio, without carrying credentials", () => {
  const names = codexNativeMcpNames(
    JSON.stringify([
      {
        name: "linear",
        enabled: true,
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "fixture-secret" },
      },
      { name: "local.tools", enabled: true, command: "npx", env: { KEY: "fixture-secret" } },
      { name: "disabled", enabled: false },
      { name: "cogenly", enabled: true },
    ]),
  );
  expect(names).toEqual(["linear", "local.tools", "cogenly"]);
  const args = codexNativeMcpOffArgs(names);
  expect(args).toContain(
    'mcp_servers={"linear"={enabled=false},"local.tools"={enabled=false},"cogenly"={enabled=false}}',
  );
  expect(args).toContain("features.plugins=false");
  expect(args).toContain("features.apps=false");
  expect(JSON.stringify(args)).not.toContain("fixture-secret");
});

it("disables every configured server using the installed Codex CLI merge semantics", (context) => {
  const home = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/cogenly-native-mcp-`);
  try {
    const options = {
      cwd: home,
      env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH },
      encoding: "utf8" as const,
      timeout: 20_000,
    };
    const version = NodeChildProcess.spawnSync("codex", ["--version"], options);
    if (version.error && "code" in version.error && version.error.code === "ENOENT")
      return context.skip();
    expect(version.status).toBe(0);
    const names = ["first", "second", "local.tools", 'quoted"name'];
    NodeFS.writeFileSync(
      `${home}/config.toml`,
      names
        .map((name) => `[mcp_servers.${JSON.stringify(name)}]\nurl="https://fixture.example/mcp"`)
        .join("\n"),
    );
    const result = NodeChildProcess.spawnSync(
      "codex",
      [...codexNativeMcpOffArgs(names), "mcp", "list", "--json"],
      options,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(result.stdout).map((server: { name: string; enabled: boolean }) => ({
        name: server.name,
        enabled: server.enabled,
      })),
    ).toEqual([...names].sort().map((name) => ({ name, enabled: false })));
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it.effect("halts on unavailable inventories with a safe turn/status message", () =>
  Effect.gen(function* () {
    for (const stage of ["launch", "thread"] as const) {
      const error = yield* requireCodexNativeMcpEnumeration(
        stage,
        Effect.fail("fixture-private-token"),
      ).pipe(Effect.flip);
      expect(error.stage).toBe(stage);
      const message = userFacingDispatchErrorMessage({ cause: error });
      expect(message).toContain("turn was stopped");
      expect(message).toContain("plugins and apps disabled");
      expect(JSON.stringify(error)).not.toContain("fixture-private-token");
    }
  }),
);

import { expect, it } from "vite-plus/test";
import { codexNativeMcpNames, codexNativeMcpOffArgs } from "./NativeMcpPolicy.ts";
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
  expect(args).toContain('mcp_servers={"local.tools"={enabled=false}}');
  expect(args).toContain("features.plugins=false");
  expect(args).toContain("features.apps=false");
  expect(JSON.stringify(args)).not.toContain("fixture-secret");
});

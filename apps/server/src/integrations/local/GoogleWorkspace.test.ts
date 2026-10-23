import { expect, it } from "vite-plus/test";
import { googleClientFromJson } from "./GoogleWorkspace.ts";
import { managedPackageCommand } from "./ManagedPackage.ts";

it("reads a Google Web client export or a client pair without exposing values in arguments", () => {
  for (const data of [
    {
      web: {
        client_id: "id",
        client_secret: "secret",
        redirect_uris: ["https://example.com/callback"],
      },
    },
    { client_id: "id", client_secret: "secret" },
  ]) {
    expect(googleClientFromJson(JSON.stringify(data))).toMatchObject({
      _tag: "Some",
      value: { clientId: "id", clientSecret: "secret" },
    });
  }
  expect(googleClientFromJson("not-json")._tag).toBe("None");
  expect(googleClientFromJson('{"web":{"client_id":"id"}}')._tag).toBe("None");
});

it("resolves exact Python and Node releases through their package runners", () => {
  expect(
    managedPackageCommand({ ecosystem: "python", name: "workspace-mcp", version: "2.1.2" }),
  ).toEqual({ runtime: "uvx", args: ["workspace-mcp@2.1.2"] });
  expect(
    managedPackageCommand({ ecosystem: "node", name: "@example/mcp", version: "1.2.3" }),
  ).toEqual({ runtime: "npx", args: ["-y", "@example/mcp@1.2.3"] });
});

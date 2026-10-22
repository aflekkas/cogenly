import { describe, expect, it } from "vite-plus/test";

import {
  buildAddEnvironmentLink,
  defaultSshEnvironmentName,
  detectHostingProvider,
  parseAddEnvironmentLink,
  parseAddEnvironmentRequest,
} from "./environmentLinks.ts";

describe("parseAddEnvironmentLink", () => {
  it("reads the alias and name of an add link", () => {
    expect(
      parseAddEnvironmentLink("cogenly://environments/add?ssh=t3vps&name=Contabo%20VPS"),
    ).toEqual({ ok: true, value: { ssh: "t3vps", name: "Contabo VPS" } });
    expect(parseAddEnvironmentLink("cogenly-dev://environments/add/?ssh=alex@box.lan")).toEqual({
      ok: true,
      value: { ssh: "alex@box.lan", name: null },
    });
  });

  it("leaves other links to their own handlers", () => {
    expect(parseAddEnvironmentLink("cogenly://new?prompt=hi")).toBeNull();
    expect(parseAddEnvironmentLink("cogenly://environments/remove?ssh=box")).toBeNull();
    expect(parseAddEnvironmentLink("https://environments/add?ssh=box")).toBeNull();
    expect(parseAddEnvironmentLink("not a url")).toBeNull();
  });

  it("refuses hosts that could pass for ssh options or shell syntax", () => {
    for (const ssh of [
      "-oProxyCommand=touch%20/tmp/x",
      "box;rm",
      "box%20other",
      "$(id)",
      "box/../x",
      "",
    ]) {
      const result = parseAddEnvironmentLink(`cogenly://environments/add?ssh=${ssh}`);
      expect(result?.ok, ssh).toBe(false);
    }
    expect(parseAddEnvironmentLink("cogenly://environments/add?name=VPS")).toEqual({
      ok: false,
      error: "This link does not name an SSH host.",
    });
  });

  it("strips hidden characters from the name and bounds its length", () => {
    expect(
      parseAddEnvironmentLink("cogenly://environments/add?ssh=box&name=My%E2%80%8B%20%20VPS"),
    ).toEqual({ ok: true, value: { ssh: "box", name: "My VPS" } });
    expect(parseAddEnvironmentLink("cogenly://environments/add?ssh=box&name=%E2%80%8B")?.ok).toBe(
      false,
    );
    expect(parseAddEnvironmentRequest({ ssh: "box", name: "x".repeat(65) }).ok).toBe(false);
    expect(parseAddEnvironmentRequest({ ssh: "box", name: "  " })).toEqual({
      ok: true,
      value: { ssh: "box", name: null },
    });
  });

  it("round-trips the links it builds", () => {
    const link = buildAddEnvironmentLink({ ssh: "t3vps", name: "Contabo VPS" });
    expect(link).toBe("cogenly://environments/add?ssh=t3vps&name=Contabo%20VPS");
    expect(parseAddEnvironmentLink(link)).toEqual({
      ok: true,
      value: { ssh: "t3vps", name: "Contabo VPS" },
    });
  });
});

describe("defaultSshEnvironmentName", () => {
  it("prefers the requested name", () => {
    expect(
      defaultSshEnvironmentName({
        requestedName: " Contabo VPS ",
        serverLabel: "vmi2345678",
        sshAlias: "t3vps",
      }),
    ).toBe("Contabo VPS");
  });

  it("keeps a name a person gave the host", () => {
    expect(defaultSshEnvironmentName({ serverLabel: "Alex's Server", sshAlias: "t3vps" })).toBe(
      "Alex's Server",
    );
    expect(defaultSshEnvironmentName({ serverLabel: "atlas", sshAlias: "atlas" })).toBe("atlas");
  });

  it("names a provider's generated host after the provider", () => {
    expect(defaultSshEnvironmentName({ serverLabel: "vmi2345678", sshAlias: "t3vps" })).toBe(
      "Contabo VPS",
    );
    expect(
      defaultSshEnvironmentName({ serverLabel: "ubuntu-4gb-nbg1-1", sshAlias: "server" }),
    ).toBe("Hetzner VPS");
    expect(
      defaultSshEnvironmentName({
        serverLabel: "203.0.113.7",
        sshAlias: "box",
        sshHostname: "vmi2345678.contaboserver.net",
      }),
    ).toBe("Contabo VPS");
  });

  it("never uses a raw alias with t3 in it", () => {
    expect(defaultSshEnvironmentName({ serverLabel: "t3vps", sshAlias: "t3vps" })).toBe("VPS");
    expect(
      defaultSshEnvironmentName({
        serverLabel: null,
        sshAlias: "t3vps",
        sshHostname: "203.0.113.7",
      }),
    ).toBe("VPS");
    expect(defaultSshEnvironmentName({ serverLabel: "localhost", sshAlias: "t3-box" })).toBe("VPS");
  });
});

describe("detectHostingProvider", () => {
  it("recognizes providers by their hostnames and domains", () => {
    expect(detectHostingProvider(["ubuntu-s-1vcpu-1gb-nyc1-01"])).toBe("DigitalOcean");
    expect(detectHostingProvider(["static.88-99.clients.your-server.de"])).toBe("Hetzner");
    expect(detectHostingProvider(["ip-10-0-0-12"])).toBe("AWS");
    expect(detectHostingProvider(["vps-1a2b3c4d"])).toBe("OVH");
    expect(detectHostingProvider([null, "atlas", "203.0.113.7"])).toBeNull();
  });
});

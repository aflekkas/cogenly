import { assert, describe, it } from "@effect/vitest";

import {
  chooseServePort,
  findTailscaleControlUrl,
  parseServeMappings,
  parseTailscaleStatusSnapshot,
  targetsLocalPort,
} from "./tailscaleState.ts";

const runningStatus = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "hub.tail1234.ts.net.", CapMap: {} },
    CurrentTailnet: { Name: "alex@example.com", MagicDNSSuffix: "tail1234.ts.net" },
    CertDomains: ["hub.tail1234.ts.net"],
    ...extra,
  });

describe("tailscale status", () => {
  it("reads a signed-in node with HTTPS allowed", () => {
    assert.deepEqual(parseTailscaleStatusSnapshot(runningStatus()), {
      backendState: "Running",
      authUrl: null,
      magicDnsName: "hub.tail1234.ts.net",
      tailnetName: "alex@example.com",
      httpsEnabled: true,
    });
  });

  it("reads HTTPS as off while CertDomains is null, and unknown until signed in", () => {
    assert.isFalse(
      parseTailscaleStatusSnapshot(runningStatus({ CertDomains: null }))?.httpsEnabled,
    );
    assert.isNull(
      parseTailscaleStatusSnapshot(JSON.stringify({ BackendState: "NeedsLogin" }))?.httpsEnabled,
    );
  });

  it("keeps only Tailscale's own sign-in links", () => {
    const pending = (url: string) =>
      parseTailscaleStatusSnapshot(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: url }));
    assert.equal(
      pending("https://login.tailscale.com/a/abc123")?.authUrl,
      "https://login.tailscale.com/a/abc123",
    );
    assert.isNull(pending("https://login.tailscale.com.evil.example/a/abc")?.authUrl);
    assert.isNull(pending("http://login.tailscale.com/a/abc")?.authUrl);
  });

  it("returns null for output that is not status JSON", () => {
    assert.isNull(parseTailscaleStatusSnapshot("failed to connect to local tailscaled"));
  });
});

describe("tailscale serve status", () => {
  const serveJson = JSON.stringify({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      "hub.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
      "hub.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://localhost:5000" } } },
    },
    AllowFunnel: { "hub.tail1234.ts.net:8443": true },
  });

  it("lists each HTTPS port with its target and Funnel", () => {
    assert.deepEqual(parseServeMappings(serveJson), [
      { port: 443, target: "http://127.0.0.1:3773", funnel: false },
      { port: 8443, target: "http://localhost:5000", funnel: true },
    ]);
  });

  it("reads an empty configuration as no mappings", () => {
    assert.deepEqual(parseServeMappings(""), []);
    assert.deepEqual(parseServeMappings("{}"), []);
    assert.isNull(parseServeMappings("not json"));
  });

  it("matches only this server's loopback listener", () => {
    assert.isTrue(targetsLocalPort("http://127.0.0.1:3773", 3773));
    assert.isTrue(targetsLocalPort("http://localhost:3773/", 3773));
    assert.isTrue(targetsLocalPort("3773", 3773));
    assert.isFalse(targetsLocalPort("http://127.0.0.1:3774", 3773));
    assert.isFalse(targetsLocalPort("http://10.0.0.5:3773", 3773));
    assert.isFalse(targetsLocalPort("https+insecure://127.0.0.1:3773", 3773));
  });
});

describe("choosing a Serve port", () => {
  const mapping = (port: number, target: string) => ({ port, target, funnel: false });

  it("keeps the port already pointing at this server", () => {
    assert.deepEqual(chooseServePort([mapping(8443, "http://127.0.0.1:3773")], 3773, 443), {
      _tag: "ours",
      port: 8443,
      funnel: false,
    });
  });

  it("never takes over a port serving something else", () => {
    assert.deepEqual(chooseServePort([mapping(443, "http://127.0.0.1:9000")], 3773, 443), {
      _tag: "free",
      port: 8443,
    });
    assert.deepEqual(
      chooseServePort(
        [
          mapping(443, "http://127.0.0.1:1"),
          mapping(8443, "http://127.0.0.1:2"),
          mapping(10000, "http://127.0.0.1:3"),
        ],
        3773,
        443,
      ),
      { _tag: "none" },
    );
  });

  it("repoints its own mapping after the local port changed, keeping the address", () => {
    assert.deepEqual(chooseServePort([mapping(443, "http://127.0.0.1:3000")], 3773, 443, 3000), {
      _tag: "free",
      port: 443,
    });
  });
});

describe("links in CLI output", () => {
  it("finds the Serve approval link the CLI prints while it waits", () => {
    const output =
      "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n";
    assert.equal(
      findTailscaleControlUrl(output),
      "https://login.tailscale.com/f/serve?node=nABC123",
    );
  });

  it("ignores links to other hosts", () => {
    assert.isNull(findTailscaleControlUrl("see https://example.com/tailscale.com/a/1"));
  });
});

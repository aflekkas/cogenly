import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildMachineSecurityStatus,
  isLoopbackHost,
  parseLsofListening,
  parseSsListening,
  parseSshdEffective,
  parseTailscale,
  parseUfw,
  wideBindWarning,
} from "./MachineSecurity.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

// Ubuntu fixture: sshd on 0.0.0.0:22 and [::]:22, Cogenly on 127.0.0.1:4773,
// ufw allowing OpenSSH and two app ports, no Tailscale.
const UBUNTU_SS = [
  'LISTEN 0 4096 127.0.0.1:4773 0.0.0.0:* users:(("node",pid=100,fd=20))',
  'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=200,fd=3))',
  'LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=200,fd=4))',
].join("\n");
const UBUNTU_UFW = [
  "Status: active",
  "",
  "To                         Action      From",
  "--                         ------      ----",
  "OpenSSH                    ALLOW       Anywhere",
  "8080/tcp                   ALLOW       Anywhere",
  "9000/tcp                   ALLOW       Anywhere",
].join("\n");

describe("machine security parsers", () => {
  it.effect("parses ss listeners and marks loopback", () =>
    Effect.sync(() => {
      const sockets = parseSsListening(UBUNTU_SS);
      assert.equal(sockets.length, 3);
      assert.deepEqual(sockets[0], {
        address: "127.0.0.1",
        port: 4773,
        process: "node",
        loopback: true,
      });
      assert.equal(sockets[1]?.loopback, false);
      assert.equal(sockets[2]?.address, "::");
    }),
  );
  it.effect("parses lsof listeners", () =>
    Effect.sync(() => {
      const sockets = parseLsofListening(
        "node 100 user 20u IPv4 0x0 0t0 TCP 127.0.0.1:4773 (LISTEN)",
      );
      assert.deepEqual(sockets, [
        { address: "127.0.0.1", port: 4773, process: "node", loopback: true },
      ]);
    }),
  );
  it.effect("parses sshd and ufw", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshdEffective("passwordauthentication no\npermitrootlogin prohibit-password\n"),
        {
          passwordAuthentication: "no",
          kbdInteractiveAuthentication: null,
          permitRootLogin: "prohibit-password",
        },
      );
      assert.equal(parseSshdEffective(""), null);
      assert.equal(parseUfw(UBUNTU_UFW)?.active, true);
      assert.equal(parseUfw(UBUNTU_UFW)?.rules.length, 3);
      assert.equal(parseUfw(null), null);
    }),
  );
  it.effect("detects tailscale funnel and serve targets", () =>
    Effect.sync(() => {
      const ts = parseTailscale({
        statusJson: JSON.stringify({ BackendState: "Running", Self: {} }),
        serveJson: JSON.stringify({
          Web: { "host:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4773" } } } },
        }),
        funnelText: null,
      });
      assert.equal(ts?.loggedIn, true);
      assert.equal(ts?.funnelEnabled, false);
      assert.isTrue((ts?.serveTargets.length ?? 0) > 0);
      assert.equal(parseTailscale({ statusJson: null, serveJson: null, funnelText: null }), null);
    }),
  );
  it.effect("wide-bind warning only for non-loopback", () =>
    Effect.sync(() => {
      assert.equal(isLoopbackHost("127.0.0.1"), true);
      assert.equal(isLoopbackHost("::1"), true);
      assert.equal(wideBindWarning("127.0.0.1"), null);
      assert.include(wideBindWarning("0.0.0.0")!, "0.0.0.0");
    }),
  );
  it.effect("Ubuntu fixture gives attention, never green without evidence", () =>
    Effect.sync(() => {
      const status = buildMachineSecurityStatus(
        {
          platform: "linux",
          cogenlyHost: "127.0.0.1",
          cogenlyPort: 4773,
          sockets: parseSsListening(UBUNTU_SS),
          socketsEvidence: "ss -H -ltnp",
          sshd: null,
          tailscale: null,
          firewall: parseUfw(UBUNTU_UFW),
        },
        now,
      );
      assert.equal(status.state, "attention");
      assert.equal(status.cogenlyBind.loopback, true);
      assert.isTrue(
        status.findings.some((f) => f.checkId === "listening-sockets" && f.status === "warn"),
      );
      assert.isTrue(status.findings.some((f) => f.checkId === "sshd" && f.status === "unknown"));
    }),
  );
  it.effect("all-pass gives private_verified and all-unknown gives unknown", () =>
    Effect.sync(() => {
      const base = {
        platform: "linux",
        cogenlyHost: "127.0.0.1",
        cogenlyPort: 4773,
        socketsEvidence: "ss -H -ltnp",
      };
      const green = buildMachineSecurityStatus(
        {
          ...base,
          sockets: parseSsListening(
            'LISTEN 0 4096 127.0.0.1:4773 0.0.0.0:* users:(("node",pid=1,fd=1))',
          ),
          sshd: parseSshdEffective(
            "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\n",
          ),
          tailscale: {
            installed: true,
            loggedIn: true,
            serveTargets: ["http://127.0.0.1:4773"],
            funnelEnabled: false,
          },
          firewall: parseUfw(UBUNTU_UFW),
        },
        now,
      );
      assert.equal(green.state, "private_verified");
      const unknown = buildMachineSecurityStatus(
        { ...base, sockets: null, sshd: null, tailscale: null, firewall: null },
        now,
      );
      // cogenly-bind is known from config, so this is incomplete, not all-unknown.
      assert.equal(unknown.state, "incomplete");
    }),
  );
});

it.effect("machine security reports the startup chat sandbox result", () =>
  Effect.sync(() => {
    const base = {
      platform: "linux",
      cogenlyHost: "127.0.0.1",
      cogenlyPort: 4773,
      sockets: null,
      socketsEvidence: "unavailable",
      sshd: null,
      tailscale: null,
      firewall: null,
    };
    const available = buildMachineSecurityStatus(
      { ...base, chatSandbox: { available: true, backend: "bwrap" } },
      now,
    );
    assert.equal(
      available.findings.find((f) => f.checkId === "chat-terminal-sandbox")?.status,
      "pass",
    );
    const denied = buildMachineSecurityStatus(
      { ...base, chatSandbox: { available: false, reason: "probe failed" } },
      now,
    );
    assert.equal(
      denied.findings.find((f) => f.checkId === "chat-terminal-sandbox")?.detail,
      "probe failed",
    );
    assert.equal(
      denied.findings.find((f) => f.checkId === "chat-terminal-sandbox")?.status,
      "warn",
    );
  }),
);

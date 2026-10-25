import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
/**
 * MachineSecurity: read-only, non-root posture check of this machine.
 * Every transport (WebSocket RPC, MCP, CLI) calls the same `status`.
 * Never green without evidence: an un-runnable check is `unknown`.
 */
import type {
  MachineSecurityFinding,
  MachineSecurityListeningSocket,
  MachineSecurityState,
  MachineSecurityStatus,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";

export const isLoopbackHost = (host: string): boolean => {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
};
export const isWideBindHost = (host: string): boolean => !isLoopbackHost(host);

/** Warning text for a wide bind, or null for loopback. Shared by server, desktop and WSL paths. */
export const wideBindWarning = (host: string, what = "Cogenly"): string | null =>
  isWideBindHost(host)
    ? `${what} is bound to ${host}, which is not loopback. It may be reachable from the network wherever the host and provider firewalls allow it, over plain HTTP. Prefer 127.0.0.1 with Tailscale Serve, or keep this only if you chose public/LAN access deliberately.`
    : null;

// --- Pure parsers -----------------------------------------------------------

const splitHostPort = (local: string): { address: string; port: number } | null => {
  const idx = local.lastIndexOf(":");
  if (idx < 0) return null;
  const port = Number.parseInt(local.slice(idx + 1), 10);
  if (!Number.isInteger(port)) return null;
  return { address: local.slice(0, idx).replace(/^\[|\]$/g, ""), port };
};

/** Parse `ss -H -ltnp` (Linux). Columns: State Recv-Q Send-Q Local Peer [Process]. */
export const parseSsListening = (output: string): MachineSecurityListeningSocket[] => {
  const out: MachineSecurityListeningSocket[] = [];
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || t[0] !== "LISTEN") continue;
    const hp = splitHostPort(t[3]!);
    if (!hp) continue;
    const proc = /"([^"]+)"/.exec(line)?.[1] ?? null;
    out.push({ ...hp, process: proc, loopback: isLoopbackHost(hp.address) });
  }
  return out;
};

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` (macOS). NAME is the last field before `(LISTEN)`. */
export const parseLsofListening = (output: string): MachineSecurityListeningSocket[] => {
  const out: MachineSecurityListeningSocket[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /TCP\s+(\S+)\s+\(LISTEN\)/.exec(line);
    if (!m) continue;
    const hp = splitHostPort(m[1]!);
    if (!hp) continue;
    const process = line.trim().split(/\s+/)[0] ?? null;
    out.push({ ...hp, process, loopback: isLoopbackHost(hp.address) });
  }
  return out;
};

/** Parse `sshd -T` key/value output. Returns null when no usable keys were seen. */
export const parseSshdEffective = (
  output: string,
): {
  passwordAuthentication: string | null;
  kbdInteractiveAuthentication: string | null;
  permitRootLogin: string | null;
} | null => {
  const map = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k && rest.length > 0) map.set(k.toLowerCase(), rest.join(" ").toLowerCase());
  }
  if (map.size === 0) return null;
  return {
    passwordAuthentication: map.get("passwordauthentication") ?? null,
    kbdInteractiveAuthentication:
      map.get("kbdinteractiveauthentication") ?? map.get("challengeresponseauthentication") ?? null,
    permitRootLogin: map.get("permitrootlogin") ?? null,
  };
};

export interface TailscaleObservation {
  readonly installed: boolean;
  readonly loggedIn: boolean;
  readonly serveTargets: readonly string[];
  readonly funnelEnabled: boolean;
}

/** Parse `tailscale status --json` plus serve/funnel status text/JSON. */
export const parseTailscale = (input: {
  readonly statusJson: string | null;
  readonly serveJson: string | null;
  readonly funnelText: string | null;
}): TailscaleObservation | null => {
  if (input.statusJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.statusJson);
  } catch {
    return null;
  }
  const status = parsed as { BackendState?: string; Self?: { DNSName?: string } };
  const loggedIn = status.BackendState === "Running";
  const serveTargets: string[] = [];
  if (input.serveJson) {
    const collect = (v: unknown): void => {
      if (typeof v === "string" && /127\.0\.0\.1|localhost/.test(v)) serveTargets.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    try {
      collect(JSON.parse(input.serveJson));
    } catch {
      /* serve output unreadable: no targets */
    }
  }
  const funnelEnabled =
    (input.funnelText !== null &&
      /funnel/i.test(input.funnelText) &&
      !/no funnel/i.test(input.funnelText)) ||
    (input.serveJson !== null &&
      /"AllowFunnel"|funnel/i.test(input.serveJson) &&
      /true/i.test(input.serveJson));
  return { installed: true, loggedIn, serveTargets, funnelEnabled };
};

/** Parse `ufw status` (first line carries the state). */
export const parseUfw = (
  output: string | null,
): { active: boolean; rules: readonly string[] } | null => {
  if (output === null) return null;
  const active = /^Status:\s*active/im.test(output);
  if (!active && !/^Status:\s*inactive/im.test(output)) return null;
  const rules = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /ALLOW|DENY|LIMIT/.test(l));
  return { active, rules };
};

// --- State derivation -------------------------------------------------------

export interface MachineSecurityInputs {
  readonly chatSandbox?: ReadOnlySandbox.SandboxStatus;
  readonly platform: string;
  readonly cogenlyHost: string;
  readonly cogenlyPort: number;
  readonly sockets: readonly MachineSecurityListeningSocket[] | null;
  readonly socketsEvidence: string;
  readonly sshd: ReturnType<typeof parseSshdEffective>;
  readonly tailscale: TailscaleObservation | null;
  readonly firewall: ReturnType<typeof parseUfw>;
}

export const buildMachineSecurityStatus = (
  input: MachineSecurityInputs,
  observedAt: MachineSecurityStatus["observedAt"],
): MachineSecurityStatus => {
  const findings: MachineSecurityFinding[] = [];
  if (input.chatSandbox)
    findings.push({
      checkId: "chat-terminal-sandbox",
      status: input.chatSandbox.available ? "pass" : "warn",
      title: input.chatSandbox.available
        ? "Chat terminal sandbox available"
        : `Chat commands are off: ${input.chatSandbox.reason}`,
      detail: input.chatSandbox.available
        ? "Chat terminals cannot write local files outside their private temporary directory. Network requests remain available."
        : input.chatSandbox.reason,
      evidence: input.chatSandbox.available
        ? input.chatSandbox.backend
        : (input.chatSandbox.failure ?? "confinement probe unavailable"),
    });
  const loopback = isLoopbackHost(input.cogenlyHost);
  findings.push(
    loopback
      ? {
          checkId: "cogenly-bind",
          status: "pass",
          title: "Cogenly binds loopback",
          detail: `Cogenly listens on ${input.cogenlyHost}:${input.cogenlyPort}.`,
          evidence: `configured host ${input.cogenlyHost}`,
        }
      : {
          checkId: "cogenly-bind",
          status: "fail",
          title: "Cogenly is not loopback-only",
          detail: wideBindWarning(input.cogenlyHost)!,
          evidence: `configured host ${input.cogenlyHost}`,
        },
  );
  if (input.sockets === null) {
    findings.push({
      checkId: "listening-sockets",
      status: "unknown",
      title: "Listening sockets unknown",
      detail: "Could not list listening sockets without extra privilege on this OS.",
      evidence: input.socketsEvidence,
    });
  } else {
    const wide = input.sockets.filter((s) => !s.loopback);
    findings.push(
      wide.length === 0
        ? {
            checkId: "listening-sockets",
            status: "pass",
            title: "No non-loopback listeners",
            detail: "Every listening TCP socket is on loopback.",
            evidence: input.socketsEvidence,
          }
        : {
            checkId: "listening-sockets",
            status: "warn",
            title: "Non-loopback listeners present",
            detail: `Listening publicly (bind): ${[...new Set(wide.map((s) => `${s.address}:${s.port}${s.process ? ` (${s.process})` : ""}`))].join(", ")}. Listening is not proof of public reachability; see the firewall finding.`,
            evidence: input.socketsEvidence,
          },
    );
  }
  if (input.sshd === null) {
    findings.push({
      checkId: "sshd",
      status: "unknown",
      title: "SSH server config unknown",
      detail: "Effective sshd config was not readable without root (sshd -T needs root on Ubuntu).",
      evidence: "sshd -T unavailable",
    });
  } else {
    const bad =
      input.sshd.passwordAuthentication === "yes" ||
      input.sshd.kbdInteractiveAuthentication === "yes" ||
      input.sshd.permitRootLogin === "yes";
    findings.push(
      bad
        ? {
            checkId: "sshd",
            status: "warn",
            title: "SSH allows password or root login",
            detail: `password=${input.sshd.passwordAuthentication ?? "?"}, keyboard-interactive=${input.sshd.kbdInteractiveAuthentication ?? "?"}, root=${input.sshd.permitRootLogin ?? "?"}. Prefer keys-only.`,
            evidence: "sshd -T",
          }
        : {
            checkId: "sshd",
            status: "pass",
            title: "SSH is keys-only",
            detail: `password=${input.sshd.passwordAuthentication ?? "?"}, keyboard-interactive=${input.sshd.kbdInteractiveAuthentication ?? "?"}, root=${input.sshd.permitRootLogin ?? "?"}.`,
            evidence: "sshd -T",
          },
    );
  }
  if (input.tailscale === null) {
    findings.push({
      checkId: "tailscale",
      status: "unknown",
      title: "Tailscale not observed",
      detail:
        "Tailscale is not installed or its status was not readable. This is not a failure by itself.",
      evidence: "tailscale status --json unavailable",
    });
  } else if (input.tailscale.funnelEnabled) {
    findings.push({
      checkId: "tailscale",
      status: "fail",
      title: "Tailscale Funnel is enabled",
      detail:
        "Funnel makes the served service public on the internet. Disable Funnel for private access; Serve stays tailnet-only.",
      evidence: "tailscale funnel/serve status",
    });
  } else {
    findings.push({
      checkId: "tailscale",
      status: input.tailscale.loggedIn ? "pass" : "warn",
      title: input.tailscale.loggedIn
        ? "Tailscale is logged in"
        : "Tailscale installed but not logged in",
      detail:
        input.tailscale.serveTargets.length > 0
          ? `Serve targets: ${input.tailscale.serveTargets.join(", ")}.`
          : "No Serve mapping to a loopback target was seen.",
      evidence: "tailscale status --json",
    });
  }
  if (input.firewall === null) {
    findings.push({
      checkId: "firewall",
      status: "unknown",
      title: "Host firewall unknown",
      detail:
        "Firewall state was not readable (ufw needs root on many installs). A socket listening publicly is not proof it is reachable publicly; this machine cannot prove public reachability by itself — that needs an external probe or provider firewall evidence.",
      evidence: "ufw status unavailable",
    });
  } else {
    findings.push(
      input.firewall.active
        ? {
            checkId: "firewall",
            status: "pass",
            title: "Host firewall is active",
            detail: `Rules seen: ${input.firewall.rules.join("; ") || "none listed"}. Reachable publicly still cannot be proven from this machine alone.`,
            evidence: "ufw status",
          }
        : {
            checkId: "firewall",
            status: "warn",
            title: "Host firewall is inactive",
            detail:
              "Non-loopback listeners may be reachable wherever the network/provider allows. Listening publicly is reported separately from reachable publicly, which this machine cannot prove by itself.",
            evidence: "ufw status",
          },
    );
  }
  const hasFailOrWarn = findings.some((f) => f.status === "fail" || f.status === "warn");
  const allUnknown = findings.every((f) => f.status === "unknown");
  const hasUnknown = findings.some((f) => f.status === "unknown");
  const state: MachineSecurityState = hasFailOrWarn
    ? "attention"
    : allUnknown
      ? "unknown"
      : hasUnknown
        ? "incomplete"
        : "private_verified";
  return {
    state,
    observedAt,
    platform: input.platform,
    cogenlyBind: { host: input.cogenlyHost, port: input.cogenlyPort, loopback },
    listeningSockets: input.sockets ?? [],
    findings,
    summary:
      state === "private_verified"
        ? "Private access verified from this machine's evidence."
        : state === "attention"
          ? "Attention needed: see findings."
          : state === "incomplete"
            ? "Setup incomplete: some checks could not be observed."
            : "Unknown: no check could be observed with evidence.",
  };
};

// --- Service ----------------------------------------------------------------

export class MachineSecurity extends Context.Service<
  MachineSecurity,
  {
    readonly status: Effect.Effect<
      MachineSecurityStatus,
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
  }
>()("cogenly-server/security/MachineSecurity") {}

const runText = (
  command: string,
  args: readonly string[],
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdin: "ignore" }),
      );
      const [stdout, code] = yield* Effect.all(
        [
          Stream.runFold(
            child.stdout,
            () => "",
            (a, c) => a + new TextDecoder().decode(c),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return Number(code) === 0 ? stdout : null;
    }),
  ).pipe(
    Effect.timeout(Duration.seconds(3)),
    Effect.orElseSucceed(() => null),
  );

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sandbox = yield* ReadOnlySandbox.ReadOnlySandbox;
  const status = Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const isLinux = platform === "linux";
    const socketsRaw = isLinux
      ? yield* runText("ss", ["-H", "-ltnp"])
      : platform === "darwin"
        ? yield* runText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
        : null;
    const sockets =
      socketsRaw === null
        ? null
        : isLinux
          ? parseSsListening(socketsRaw)
          : parseLsofListening(socketsRaw);
    const sshdRaw = yield* runText("sshd", ["-T"]);
    const tsStatus = yield* runText("tailscale", ["status", "--json"]);
    const tsServe = yield* runText("tailscale", ["serve", "status", "--json"]);
    const tsFunnel = yield* runText("tailscale", ["funnel", "status"]);
    const ufwRaw = isLinux ? yield* runText("ufw", ["status"]) : null;
    return buildMachineSecurityStatus(
      {
        platform,
        chatSandbox: sandbox.status,
        cogenlyHost: config.host ?? "127.0.0.1",
        cogenlyPort: config.port,
        sockets,
        socketsEvidence:
          socketsRaw === null
            ? "socket listing unavailable"
            : isLinux
              ? "ss -H -ltnp"
              : "lsof -nP -iTCP -sTCP:LISTEN",
        sshd: sshdRaw === null ? null : parseSshdEffective(sshdRaw),
        tailscale: parseTailscale({
          statusJson: tsStatus,
          serveJson: tsServe,
          funnelText: tsFunnel,
        }),
        firewall: parseUfw(ufwRaw),
      },
      DateTime.nowUnsafe(),
    );
  }).pipe(Effect.withSpan("machineSecurity.status"));
  return MachineSecurity.of({ status });
});

export const layer = Layer.effect(MachineSecurity, make).pipe(Layer.provide(ReadOnlySandbox.layer));

/**
 * Pure readers for the Tailscale CLI's JSON output. They tolerate missing
 * fields and versions that add new ones: anything unreadable reads as
 * "unknown", never as a confident answer.
 */

/** `BackendState` from `tailscale status --json`. */
export type TailscaleBackendState =
  | "NoState"
  | "NeedsLogin"
  | "NeedsMachineAuth"
  | "Stopped"
  | "Starting"
  | "Running"
  | "unknown";

export interface TailscaleStatusSnapshot {
  readonly backendState: TailscaleBackendState;
  /** Set while a sign-in started elsewhere waits for the user. */
  readonly authUrl: string | null;
  readonly magicDnsName: string | null;
  readonly tailnetName: string | null;
  /** Null when the node is not connected, so the answer is unknown. */
  readonly httpsEnabled: boolean | null;
}

const BACKEND_STATES = new Set<TailscaleBackendState>([
  "NoState",
  "NeedsLogin",
  "NeedsMachineAuth",
  "Stopped",
  "Starting",
  "Running",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** Sign-in and approval links come only from Tailscale's own control plane. */
export const isTailscaleControlUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "tailscale.com" || url.hostname.endsWith(".tailscale.com"))
    );
  } catch {
    return false;
  }
};

export const parseTailscaleStatusSnapshot = (json: string): TailscaleStatusSnapshot | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const status = record(parsed);
  if (status === null) return null;
  const rawState = status.BackendState;
  const backendState =
    typeof rawState === "string" && BACKEND_STATES.has(rawState as TailscaleBackendState)
      ? (rawState as TailscaleBackendState)
      : "unknown";
  const self = record(status.Self);
  const tailnet = record(status.CurrentTailnet);
  const authUrl = nonEmptyString(status.AuthURL);
  const certDomains = Array.isArray(status.CertDomains) ? status.CertDomains : [];
  const capMap = record(self?.CapMap);
  const capabilities = Array.isArray(self?.Capabilities) ? self.Capabilities : [];
  const hasHttpsCap =
    (capMap !== null && "https" in capMap) || capabilities.some((cap) => cap === "https");
  return {
    backendState,
    authUrl: authUrl !== null && isTailscaleControlUrl(authUrl) ? authUrl : null,
    magicDnsName: nonEmptyString(self?.DNSName)?.replace(/\.$/u, "") ?? null,
    tailnetName: nonEmptyString(tailnet?.Name),
    // CertDomains is null while HTTPS is off for the tailnet.
    httpsEnabled: backendState === "Running" ? certDomains.length > 0 || hasHttpsCap : null,
  };
};

/** What Tailscale Serve does with one HTTPS port. */
export interface ServePortMapping {
  readonly port: number;
  /** The proxy target of the `/` handler, such as `http://127.0.0.1:3773`. */
  readonly target: string | null;
  readonly funnel: boolean;
}

/** Every HTTPS port in `tailscale serve status --json`. An empty config reads as `[]`. */
export const parseServeMappings = (json: string): ReadonlyArray<ServePortMapping> | null => {
  const trimmed = json.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const config = record(parsed);
  if (config === null) return [];
  const ports = new Map<number, { target: string | null; funnel: boolean }>();
  const tcp = record(config.TCP) ?? {};
  for (const [port, handler] of Object.entries(tcp)) {
    const value = Number.parseInt(port, 10);
    if (Number.isInteger(value) && record(handler)?.HTTPS === true) {
      ports.set(value, { target: null, funnel: false });
    }
  }
  const web = record(config.Web) ?? {};
  for (const [hostPort, site] of Object.entries(web)) {
    const value = Number.parseInt(hostPort.slice(hostPort.lastIndexOf(":") + 1), 10);
    if (!Number.isInteger(value)) continue;
    const handlers = record(record(site)?.Handlers) ?? {};
    const target = nonEmptyString(record(handlers["/"])?.Proxy);
    ports.set(value, { target, funnel: ports.get(value)?.funnel ?? false });
  }
  const funnel = record(config.AllowFunnel) ?? {};
  for (const [hostPort, allowed] of Object.entries(funnel)) {
    const value = Number.parseInt(hostPort.slice(hostPort.lastIndexOf(":") + 1), 10);
    if (allowed === true && Number.isInteger(value)) {
      ports.set(value, { target: ports.get(value)?.target ?? null, funnel: true });
    }
  }
  return [...ports.entries()]
    .map(([port, mapping]) => ({ port, ...mapping }))
    .toSorted((left, right) => left.port - right.port);
};

/** Whether a Serve target is this server's loopback listener. */
export const targetsLocalPort = (target: string | null, localPort: number): boolean => {
  if (target === null) return false;
  // Serve accepts a bare port or host:port as shorthand for http://.
  const normalized = /^\d+$/u.test(target)
    ? `http://127.0.0.1:${target}`
    : /^[a-z]+:\/\//iu.test(target)
      ? target
      : `http://${target}`;
  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return (
      url.protocol === "http:" &&
      port === localPort &&
      (host === "localhost" || host === "::1" || host.startsWith("127."))
    );
  } catch {
    return false;
  }
};

/** The HTTPS ports Tailscale Serve accepts, in the order Cogenly tries them. */
export const SERVE_PORT_CANDIDATES = [443, 8443, 10000] as const;

export type ServePortChoice =
  | { readonly _tag: "ours"; readonly port: number; readonly funnel: boolean }
  | { readonly _tag: "free"; readonly port: number }
  | { readonly _tag: "none" };

/**
 * Where this server is or should be served: the port already pointing at it,
 * else the port Cogenly last served it on when that mapping still points at
 * the previous run's local port (so paired machines keep their address), else
 * the preferred port when free, else the first free candidate. A port serving
 * anything else is never taken over.
 */
export const chooseServePort = (
  mappings: ReadonlyArray<ServePortMapping>,
  localPort: number,
  preferredPort: number,
  previousLocalPort?: number,
): ServePortChoice => {
  const ours = mappings.find((mapping) => targetsLocalPort(mapping.target, localPort));
  if (ours !== undefined) return { _tag: "ours", port: ours.port, funnel: ours.funnel };
  const stale =
    previousLocalPort === undefined || previousLocalPort === localPort
      ? undefined
      : mappings.find(
          (mapping) =>
            mapping.port === preferredPort && targetsLocalPort(mapping.target, previousLocalPort),
        );
  if (stale !== undefined) return { _tag: "free", port: stale.port };
  const taken = new Set(mappings.map((mapping) => mapping.port));
  const order = [preferredPort, ...SERVE_PORT_CANDIDATES.filter((port) => port !== preferredPort)];
  const free = order.find((port) => !taken.has(port));
  return free === undefined ? { _tag: "none" } : { _tag: "free", port: free };
};

const URL_IN_TEXT = /https:\/\/[^\s"'<>]+/gu;

/** The first Tailscale control-plane link in CLI output, such as a sign-in or approval page. */
export const findTailscaleControlUrl = (text: string): string | null =>
  [...text.matchAll(URL_IN_TEXT)]
    .map((match) => match[0].replace(/[.,)]+$/u, ""))
    .find(isTailscaleControlUrl) ?? null;

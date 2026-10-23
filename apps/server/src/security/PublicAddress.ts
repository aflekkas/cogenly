// @effect-diagnostics nodeBuiltinImport:off - Effect has no address block list or DNS lookup with every address.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

/** This machine and its local or reserved networks, which outbound fetches on a user's behalf must never reach. */
const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Also the IPv6 ranges that carry an IPv4 address a translator may route to
// without checking it: IPv4-compatible, local-use NAT64, and Teredo.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The IPv4 address a NAT64 or 6to4 address stands for, which a translator
 * will route to, so it is checked as well. Public NAT64 targets stay
 * reachable, as on IPv6-only networks.
 */
const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/** The addresses this machine's interfaces hold right now. */
const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

/**
 * Whether `address` belongs to a local or reserved network or to this machine
 * itself, including a public address one of its interfaces holds. Both lists
 * match IPv4-mapped IPv6 against their IPv4 entries.
 */
export const isLocalAddress = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded, 4);
};

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Every address a name resolves to, in resolver order. */
export type HostLookup = (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;

export const systemHostLookup: HostLookup = (host) =>
  NodeDnsPromises.lookup(host, { all: true, verbatim: true });

/**
 * A URL hostname as a resolver and the address checks see it: lowercase,
 * without IPv6 brackets or the trailing dot of a fully qualified name.
 */
export const normalizeHostname = (hostname: string) =>
  hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.+$/, "");

/**
 * The addresses to connect to for `host`, or undefined when it does not
 * resolve or any address it resolves to is local. The caller connects only to
 * addresses checked here, so a name that later resolves elsewhere (DNS
 * rebinding) changes nothing.
 */
export const publicAddresses = async (
  host: string,
  lookup: HostLookup = systemHostLookup,
): Promise<ReadonlyArray<ResolvedAddress> | undefined> => {
  const normalized = normalizeHostname(host);
  if (normalized === "") return undefined;
  const family = NodeNet.isIP(normalized);
  const addresses = family
    ? [{ address: normalized, family }]
    : await lookup(normalized).catch(() => []);
  if (addresses.length === 0) return undefined;
  const local = addresses.some(({ address, family }) => isLocalAddress(address, family));
  return local ? undefined : addresses;
};

/**
 * A `net.connect` / `tls.connect` lookup that answers every name with
 * addresses already checked by `publicAddresses`. The socket keeps the
 * original host for TLS SNI and the HTTP Host header.
 */
export const pinnedLookup =
  (addresses: ReadonlyArray<ResolvedAddress>): NodeNet.LookupFunction =>
  (_host, options, callback) =>
    options.all
      ? (callback as (error: null, addresses: ReadonlyArray<ResolvedAddress>) => void)(
          null,
          addresses,
        )
      : callback(null, addresses[0]!.address, addresses[0]!.family);

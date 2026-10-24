import { isLocalLoopbackHost } from "@cogenly/shared/hostClassification";

/** Network peer traffic requires TLS. Plaintext is only for a local SSH forward. */
export const normalizePeerRoute = (route: string): string => {
  const url = new URL(route);
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid peer route");
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalLoopbackHost(url.hostname)))
    throw new Error("Peer routes require HTTPS or loopback HTTP");
  return url.origin + "/";
};

/** Validate the whole list before dialing; never fall back from TLS to plaintext. */
export const normalizePeerRoutes = (routes: ReadonlyArray<string>) => {
  const normalized = [...new Set(routes.map(normalizePeerRoute))];
  if (
    normalized.some((route) => route.startsWith("https:")) &&
    normalized.some((route) => route.startsWith("http:"))
  ) {
    throw new Error("Peer routes cannot mix TLS and loopback transports");
  }
  return normalized;
};

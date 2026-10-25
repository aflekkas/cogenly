import * as NodeNet from "node:net";

import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@cogenly/shared/hostClassification";
import type { HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";

/**
 * Trust the transport socket, never a forwarded address as the socket's source.
 * Cloudflare's edge supplies cf-ray even if a public caller spoofs Serve headers.
 * Forwarded traffic is refused unless managed Serve is explicitly enabled; then
 * only its overwritten, single tailnet source and HTTPS forwarding tuple fits.
 * Local processes/proxy configuration remain inside this boundary.
 */
export const acceptsPeerIngress = (
  request: HttpServerRequest.HttpServerRequest,
  config: {
    readonly peerIngress?: "loopback" | "disabled";
    readonly tailscaleServeEnabled: boolean;
  },
): boolean => {
  if (config.peerIngress === "disabled") return false;
  const remote = Option.getOrUndefined(request.remoteAddress)?.replace(/^::ffff:/, "");
  if (!remote || !isLocalLoopbackHost(remote) || remote === "localhost") return false;
  const headers = request.headers;
  // Deny markers only: no client-supplied header can opt a request in.
  if (
    Object.keys(headers).some(
      (name) => name.startsWith("cf-") || name === "tailscale-funnel-request",
    )
  )
    return false;
  if ("forwarded" in headers || "via" in headers || "x-real-ip" in headers) return false;
  const forwarded = Object.keys(headers).filter((name) => name.startsWith("x-forwarded-"));
  if (forwarded.length === 0) return true; // direct local connection or SSH forward
  if (
    !config.tailscaleServeEnabled ||
    forwarded.some(
      (name) => !["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].includes(name),
    )
  )
    return false;
  const source = headers["x-forwarded-for"];
  return (
    source !== undefined &&
    NodeNet.isIP(source) !== 0 &&
    (isSharedAddressSpaceHost(source) || (source.includes(":") && isTailnetHost(source))) &&
    headers["x-forwarded-proto"] === "https" &&
    Boolean(headers["x-forwarded-host"])
  );
};

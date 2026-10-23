import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PROXIED_IMAGE_BYTES,
  imageProxyResponseHeaders,
  isBlockedProxyHost,
  parseImageProxyTarget,
  selectProxiedImageResponse,
} from "./ImageProxyFetch.ts";

describe("parseImageProxyTarget", () => {
  it("accepts a public https image URL", () => {
    expect(
      parseImageProxyTarget("https://upload.wikimedia.org/wikipedia/commons/1/2/x.jpg"),
    ).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/1/2/x.jpg",
    });
  });

  it.each(["http://example.com/x.jpg", "ftp://example.com/x.jpg", "data:image/png;base64,xx"])(
    "rejects the non-https target %s",
    (rawUrl) => {
      expect(parseImageProxyTarget(rawUrl)).toEqual({
        error: { status: 400, message: "Only https image URLs can be proxied." },
      });
    },
  );

  it("rejects a target that is not a URL", () => {
    expect(parseImageProxyTarget("not a url")).toEqual({
      error: { status: 400, message: "The url query parameter is not a valid URL." },
    });
  });

  it.each([
    "https://localhost/x.jpg",
    "https://127.0.0.1/x.jpg",
    "https://[::1]/x.jpg",
    "https://0.0.0.0/x.jpg",
    "https://10.1.2.3/x.jpg",
    "https://172.16.0.9/x.jpg",
    "https://192.168.1.1/x.jpg",
    "https://169.254.169.254/x.jpg",
    "https://[::ffff:10.0.0.1]/x.jpg",
    "https://[fe80::1]/x.jpg",
    "https://[fc00::1]/x.jpg",
    "https://localhost./x.jpg",
    "https://img.localhost/x.jpg",
    "https://100.64.1.2/x.jpg",
    "https://[::ffff:127.0.0.1]/x.jpg",
    "https://224.0.0.1/x.jpg",
  ])("refuses to proxy the internal host %s", (rawUrl) => {
    expect(parseImageProxyTarget(rawUrl)).toEqual({
      error: { status: 403, message: "That host cannot be proxied." },
    });
  });
});

describe("isBlockedProxyHost", () => {
  it("lets public hosts and names through", () => {
    expect(isBlockedProxyHost("upload.wikimedia.org")).toBe(false);
    expect(isBlockedProxyHost("93.184.216.34")).toBe(false);
    expect(isBlockedProxyHost("172.32.0.1")).toBe(false);
    expect(isBlockedProxyHost("192.167.1.1")).toBe(false);
    expect(isBlockedProxyHost("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks raw IPv6 literals in private ranges", () => {
    expect(isBlockedProxyHost("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedProxyHost("::ffff:a00:1")).toBe(true);
    expect(isBlockedProxyHost("::ffff:5db8:d822")).toBe(false);
    expect(isBlockedProxyHost("fe80::1%eth0")).toBe(true);
  });
});

describe("selectProxiedImageResponse", () => {
  it("serves an image content type", () => {
    expect(
      selectProxiedImageResponse({
        status: 200,
        contentType: "image/jpeg",
        declaredLength: 1024,
        bodyLength: 1024,
      }),
    ).toEqual({ status: 200, contentType: "image/jpeg" });
    expect(
      selectProxiedImageResponse({
        status: 200,
        contentType: "Image/PNG; charset=binary",
        declaredLength: undefined,
        bodyLength: 64,
      }),
    ).toEqual({ status: 200, contentType: "image/png" });
  });

  it.each([undefined, "text/html", "application/octet-stream", "image/", "image"])(
    "rejects the non-image content type %s",
    (contentType) => {
      expect(
        selectProxiedImageResponse({
          status: 200,
          contentType,
          declaredLength: 16,
          bodyLength: 16,
        }),
      ).toEqual({ status: 415, message: "The proxied URL is not an image." });
    },
  );

  it("rejects a body over the size cap, declared or streamed", () => {
    expect(
      selectProxiedImageResponse({
        status: 200,
        contentType: "image/jpeg",
        declaredLength: MAX_PROXIED_IMAGE_BYTES + 1,
        bodyLength: 0,
      }),
    ).toEqual({ status: 413, message: "The image is larger than the proxy limit." });
    expect(
      selectProxiedImageResponse({
        status: 200,
        contentType: "image/jpeg",
        declaredLength: undefined,
        bodyLength: MAX_PROXIED_IMAGE_BYTES + 1,
      }),
    ).toEqual({ status: 413, message: "The image is larger than the proxy limit." });
  });

  it("passes an upstream client error through", () => {
    expect(
      selectProxiedImageResponse({
        status: 404,
        contentType: "image/jpeg",
        declaredLength: 0,
        bodyLength: 0,
      }),
    ).toEqual({ status: 404, passthrough: true });
  });
});

describe("imageProxyResponseHeaders", () => {
  it("caches privately and blocks MIME sniffing", () => {
    expect(imageProxyResponseHeaders("image/jpeg")).toEqual({
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    });
  });

  it("sandboxes SVGs so they cannot script this origin", () => {
    expect(imageProxyResponseHeaders("image/svg+xml")["content-security-policy"]).toContain(
      "sandbox",
    );
  });
});

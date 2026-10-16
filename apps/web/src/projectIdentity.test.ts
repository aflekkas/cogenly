import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectIdentity,
  PROJECT_FALLBACK_GLYPHS,
  resolveProjectIconSource,
} from "./projectIdentity";

describe("resolveProjectIconSource", () => {
  const picked = { kind: "lucide", name: "rocket", color: "violet" } as const;

  it("uses the picked icon before the repository favicon", () => {
    expect(
      resolveProjectIconSource({
        projectIcon: picked,
        faviconSrc: "/favicon.svg",
        projectName: "web",
      }),
    ).toEqual({ kind: "picked", icon: picked });
  });

  it("uses the favicon when nothing is picked", () => {
    expect(
      resolveProjectIconSource({
        projectIcon: null,
        faviconSrc: "/favicon.svg",
        projectName: "web",
      }),
    ).toEqual({ kind: "favicon", src: "/favicon.svg" });
  });

  it("falls back to a glyph, never letters", () => {
    const source = resolveProjectIconSource({
      projectIcon: undefined,
      faviconSrc: null,
      projectName: "billing-api",
    });
    expect(source.kind).toBe("fallback");
    if (source.kind !== "fallback") return;
    expect(PROJECT_FALLBACK_GLYPHS).toContain(source.identity.glyph);
    expect(source.identity).not.toHaveProperty("monogram");
  });
});

describe("deriveProjectIdentity", () => {
  it("is stable per name and ignores case and padding", () => {
    expect(deriveProjectIdentity(" Acme-Web ")).toEqual(deriveProjectIdentity("acme-web"));
  });

  it("tells common project names apart", () => {
    const names = ["acme-web", "billing-api", "cogenly", "docs", "infra", "mobile", "sre-tools"];
    const identities = new Set(
      names.map((name) => {
        const { glyph, color } = deriveProjectIdentity(name);
        return `${glyph}:${color}`;
      }),
    );
    expect(identities.size).toBeGreaterThan(names.length - 2);
  });
});

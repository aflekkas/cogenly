// @effect-diagnostics nodeBuiltinImport:off - reads the stylesheet and boot page sources under test.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { APPEARANCE_ACCENTS, type AppearanceAccent } from "@cogenly/contracts";
import { ACCENT_PRESETS } from "@cogenly/shared/accentColors";

// The accent presets live in three places that cannot import each other: the
// stylesheet, the boot page's inline script (it runs before any bundle), and
// the shared table the Dock icon generator reads. This pins them together.
const indexCss = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");
const indexHtml = NodeFS.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function cssPresets(dark: boolean): Record<string, string> {
  const pattern = dark
    ? /:root\.dark\[data-accent="(\w+)"\],\s*\.dark \[data-accent-preview="\1"\]\s*\{\s*--accent-preset:\s*(#[0-9a-f]{6});/g
    : /:root\[data-accent="(\w+)"\],\s*\[data-accent-preview="\1"\]\s*\{\s*--accent-preset:\s*(#[0-9a-f]{6});/g;
  return Object.fromEntries([...indexCss.matchAll(pattern)].map((match) => [match[1], match[2]]));
}

describe("accent presets", () => {
  const nonOrange = APPEARANCE_ACCENTS.filter(
    (accent): accent is Exclude<AppearanceAccent, "orange"> => accent !== "orange",
  );

  it("index.css declares every shared preset, in both themes", () => {
    const light = cssPresets(false);
    const dark = cssPresets(true);
    expect(Object.keys(light).sort()).toEqual([...nonOrange].sort());
    for (const accent of nonOrange) {
      expect(light[accent], accent).toBe(ACCENT_PRESETS[accent].light);
      expect(dark[accent], accent).toBe(ACCENT_PRESETS[accent].dark);
    }
  });

  it("index.html's boot script carries the same table", () => {
    const entries = Object.fromEntries(
      [...indexHtml.matchAll(/^\s*(\w+): \["(#[0-9a-f]{6})", "(#[0-9a-f]{6})"\],$/gm)].map(
        (match) => [match[1], { light: match[2], dark: match[3] }],
      ),
    );
    expect(entries).toEqual(ACCENT_PRESETS);
  });
});

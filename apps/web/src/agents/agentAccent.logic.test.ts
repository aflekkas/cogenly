import { describe, expect, it } from "vite-plus/test";
import {
  accentForColor,
  accentForeground,
  agentAccent,
  contrastRatio,
  NEUTRAL_ACCENT,
  relativeLuminance,
} from "./agentAccent.logic";

describe("agent accent", () => {
  it("picks white text on dark fills and near-black on light and mid ones", () => {
    expect(accentForeground("#0a0a0c")).toBe("#ffffff");
    expect(accentForeground("#8b5e3c")).toBe("#ffffff");
    expect(accentForeground("#3b93f0")).toBe("#141416");
    expect(accentForeground("#f1efe9")).toBe("#141416");
    expect(accentForeground("#f0b429")).toBe("#141416");
    expect(accentForeground("#a3a3a3")).toBe("#141416");
  });

  it("meets AA for every palette colour", () => {
    for (const id of [
      "encre",
      "brun",
      "rouge",
      "orange",
      "ambre",
      "vert",
      "turquoise",
      "bleu",
      "violet",
      "rose",
      "gris",
      "creme",
    ]) {
      const accent = accentForColor(id);
      const fill = relativeLuminance(accent.color)!;
      const text = relativeLuminance(accent.foreground)!;
      expect(contrastRatio(fill, text)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("resolves palette ids and keeps custom colours, with the neutral accent as the fallback", () => {
    expect(accentForColor("bleu").color).toBe("#3b93f0");
    expect(accentForColor("rebeccapurple")).toEqual({
      color: "rebeccapurple",
      foreground: "#ffffff",
    });
    expect(accentForColor(undefined)).toBe(NEUTRAL_ACCENT);
    expect(agentAccent({ seed: "x", color: "rose" }).color).toBe("#e152b0");
  });
});

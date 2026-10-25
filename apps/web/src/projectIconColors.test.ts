import { ProjectIconColor } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProjectColor,
  PROJECT_ICON_COLORS,
  PROJECT_PALETTE_COLORS,
} from "./projectIconColors";
import { projectLabelColorValue } from "./projectLabels/projectLabels.logic";

describe("project color palette", () => {
  it("lists exactly the palette, each with a drawable hex", () => {
    expect(PROJECT_ICON_COLORS.map((color) => color.value)).toEqual([...PROJECT_PALETTE_COLORS]);
    for (const color of PROJECT_ICON_COLORS) expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("shows every color an older palette stored as one that remains", () => {
    for (const stored of ProjectIconColor.literals) {
      expect(PROJECT_PALETTE_COLORS).toContain(normalizeProjectColor(stored));
    }
    expect(normalizeProjectColor("rose")).toBe("red");
    expect(normalizeProjectColor("orange")).toBe("amber");
    expect(normalizeProjectColor("emerald")).toBe("green");
    expect(normalizeProjectColor("sky")).toBe("blue");
    expect(normalizeProjectColor("indigo")).toBe("violet");
    expect(normalizeProjectColor("fuchsia")).toBe("pink");
  });

  it("reads unknown or missing project colors as gray", () => {
    expect(projectLabelColorValue("indigo")).toBe("var(--color-violet-500)");
    expect(projectLabelColorValue("#123456")).toBe("var(--color-gray-500)");
    expect(projectLabelColorValue(undefined)).toBe("var(--color-gray-500)");
  });
});

import type { PickedElementPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeElementContextSelection } from "./elementContext";

const base: PickedElementPayload = {
  pageUrl: " https://example.com/ ",
  pageTitle: "Example",
  tagName: "BUTTON",
  selector: "#buy",
  htmlPreview: "<button>Buy</button>",
  componentName: null,
  source: null,
  stack: [],
  styles: "",
  pickedAt: "2026-10-21T00:00:00.000Z",
};

describe("normalizeElementContextSelection", () => {
  it("keeps the accessibility and DOM detail server picks carry", () => {
    const selection = normalizeElementContextSelection({
      ...base,
      role: "button",
      accessibleName: " Buy It Now ",
      attributes: { id: "buy", "data-testid": "buy-button", empty: " " },
      domPath: "body > main > button",
      textContent: "  Buy\n  It   Now ",
    });
    expect(selection).toMatchObject({
      pageUrl: "https://example.com/",
      tagName: "button",
      role: "button",
      accessibleName: "Buy It Now",
      attributes: { id: "buy", "data-testid": "buy-button" },
      domPath: "body > main > button",
      textContent: "Buy It Now",
    });
  });

  it("leaves the keys out for desktop picks, so the record still encodes", () => {
    const selection = normalizeElementContextSelection({ ...base, role: null, accessibleName: "" });
    expect(selection).not.toHaveProperty("role");
    expect(selection).not.toHaveProperty("accessibleName");
    expect(selection).not.toHaveProperty("attributes");
    expect(selection).not.toHaveProperty("textContent");
  });

  it("clamps attribute count, attribute values, and text", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 60 }, (_unused, index) => [`data-a${index}`, "x".repeat(2_000)]),
    );
    const selection = normalizeElementContextSelection({
      ...base,
      attributes,
      textContent: "y".repeat(10_000),
    });
    const kept = Object.values(selection?.attributes ?? {});
    expect(kept).toHaveLength(40);
    expect(kept.every((value) => value.length === 512 && value.endsWith("…"))).toBe(true);
    expect(selection?.textContent).toHaveLength(2_000);
  });
});

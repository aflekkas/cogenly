import { describe, expect, it } from "@effect/vitest";
import { actionOutput, compactElements, observationChanges } from "./BrowserOutput.ts";

describe("compact browser output", () => {
  it("keeps refs, names, input values and semantic states without layout containers", () => {
    const result = compactElements(
      `
- main [ref=e1] [box=0,0,800,600]:
  - generic [ref=e2] [box=0,0,800,600]:
    - heading "Account" [level=1] [box=20,10,200,30]
    - textbox "Name" [active] [ref=e3] [box=20,50,200,30]: Ada
    - checkbox "Remember me" [checked] [disabled] [ref=e4] [box=20,90,20,20]
    - button "Save \\"changes\\"" [ref=e5] [box=20,130,100,30]
    - text: Your profile
`,
      { width: 800, height: 600 },
    );
    expect(result.elements).toEqual([
      { role: "heading", name: "Account", states: ["level=1"] },
      { role: "textbox", name: "Name", ref: "e3", value: "Ada", states: ["active"] },
      { role: "checkbox", name: "Remember me", ref: "e4", states: ["checked", "disabled"] },
      { role: "button", name: 'Save "changes"', ref: "e5" },
      { role: "text", name: "Your profile" },
    ]);
  });

  it("filters offscreen elements, retains overflowing children, and supports document output", () => {
    const tree = `
- generic [box=0,-100,100,20]:
  - button "Visible overflow" [ref=e1] [box=0,10,100,20]
  - button "Offscreen" [ref=e2] [box=0,900,100,20]
- button "Zero size" [ref=e3] [box=0,0,0,0]
`;
    expect(compactElements(tree, { width: 800, height: 600 }).elements.map((e) => e.name)).toEqual([
      "Visible overflow",
    ]);
    expect(compactElements(tree).elements).toHaveLength(3);
  });

  it("handles YAML quoted keys, iframe refs, inline text, and punctuation", () => {
    expect(
      compactElements(`- 'link "Docs: API" [ref=f1e2] [box=1,1,20,20]':
    - /url: https://example.com
- paragraph: 'Hello: world'
`).elements,
    ).toEqual([
      { role: "link", name: "Docs: API", ref: "f1e2" },
      { role: "paragraph", name: "", value: "Hello: world" },
    ]);
  });

  it("bounds both element count and UTF-8 bytes and reports omissions", () => {
    const tree = Array.from(
      { length: 500 },
      (_, i) => `- button "${i} ${"好".repeat(200)}" [ref=e${i}]`,
    ).join("\n");
    const result = compactElements(tree);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12_100);
    expect(result.elements.length).toBeLessThanOrEqual(150);
    expect(result.omitted).toBe(500 - result.elements.length);
  });
});

describe("browser changes", () => {
  const before = {
    url: "https://example.com",
    title: "Form",
    elements: [
      { ref: "e1", role: "textbox", name: "Name", value: "" },
      { ref: "e2", role: "button", name: "Save" },
    ],
  };
  it("returns only updated state and added or removed elements", () => {
    expect(
      observationChanges(before, {
        url: "https://example.com/done",
        title: "Done",
        elements: [
          { ref: "e1", role: "textbox", name: "Name", value: "Ada" },
          { ref: "e3", role: "alert", name: "Saved" },
        ],
      }),
    ).toEqual({
      url: "https://example.com/done",
      title: "Done",
      changes: {
        added: [{ ref: "e3", role: "alert", name: "Saved" }],
        changed: [{ ref: "e1", role: "textbox", name: "Name", value: "Ada" }],
        removed: ["e2"],
      },
    });
  });
  it("does not repeat unchanged elements", () => {
    expect(observationChanges(before, before)).toEqual({
      changes: { added: [], changed: [], removed: [] },
    });
  });
  it("returns a current view if there is no baseline and marks a bounded view", () => {
    expect(observationChanges(undefined, before)).toBe(before);
    expect(observationChanges(before, { ...before, omitted: 30 })).toMatchObject({ omitted: 30 });
  });
});

describe("action output policy", () => {
  it("skips every read in none mode", async () => {
    let reads = 0;
    expect(
      await actionOutput({
        mode: "none",
        action: async () => ({ selected: ["one"] }),
        read: async () => {
          reads++;
          return {};
        },
        dialog: () => undefined,
      }),
    ).toEqual({ selected: ["one"] });
    expect(reads).toBe(0);
  });
  it("returns diffs by default without repeating the old page", async () => {
    let value = "";
    const result = await actionOutput({
      mode: "changes",
      before: { elements: [{ ref: "e1", role: "textbox", name: "Name", value: "" }] },
      action: async () => {
        value = "Ada";
      },
      read: async () => ({ elements: [{ ref: "e1", role: "textbox", name: "Name", value }] }),
      dialog: () => undefined,
    });
    expect(result).toEqual({
      observation: {
        changes: {
          added: [],
          changed: [{ ref: "e1", role: "textbox", name: "Name", value: "Ada" }],
          removed: [],
        },
      },
    });
  });
  it("does not fail completed actions when their destination is not ready for inspection", async () => {
    expect(
      await actionOutput({
        mode: "compact",
        action: async () => ({ selected: ["one"] }),
        read: async () => {
          throw new Error("navigating");
        },
        dialog: () => undefined,
      }),
    ).toMatchObject({ selected: ["one"], observation: { observationError: expect.any(String) } });
  });
  it("reports dialogs without trying to inspect a blocked page", async () => {
    expect(
      await actionOutput({
        mode: "compact",
        action: async () => {},
        read: async () => {
          throw new Error("must not inspect");
        },
        dialog: () => ({ type: "confirm", message: "Continue?" }),
      }),
    ).toEqual({ dialog: { type: "confirm", message: "Continue?" } });
  });
});

it("replaces the view when a viewport change would make a diff larger than a compact response", () => {
  const before = {
    elements: Array.from({ length: 100 }, (_, i) => ({
      ref: `t3-session-long-ref-${i}`,
      role: "link",
      name: `Link ${i}`,
    })),
  };
  const after = { elements: [{ ref: "new", role: "textbox", name: "Search" }] };
  expect(observationChanges(before, after)).toEqual({ ...after, reset: true });
});

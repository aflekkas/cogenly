import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { playPanelFlip, resolvePanelFlipOffsets, type PanelFlipSnapshot } from "./panelFlip";

const bounds = (left: number, right: number) => ({ left, right });

describe("resolvePanelFlipOffsets", () => {
  it("starts each anchor where it was drawn when the sidebar closes", () => {
    // The main pane grows 280px to the left; its right edge stays put.
    const offsets = resolvePanelFlipOffsets([
      { anchor: "start", before: bounds(336, 600), after: bounds(56, 320), parent: null },
      { anchor: "center", before: bounds(520, 1256), after: bounds(380, 1116), parent: null },
      { anchor: "end", before: bounds(1100, 1400), after: bounds(1100, 1400), parent: null },
    ]);
    expect(offsets).toEqual([280, 140, 0]);
  });

  it("measures a resized element from its anchor", () => {
    // A column that widens with the pane: its center moves half the distance.
    const [offset] = resolvePanelFlipOffsets([
      { anchor: "center", before: bounds(336, 1440), after: bounds(56, 1440), parent: null },
    ]);
    expect(offset).toBe(140);
  });

  it("plays only the difference from a moving ancestor", () => {
    const offsets = resolvePanelFlipOffsets([
      { anchor: "center", before: bounds(336, 1440), after: bounds(56, 1440), parent: null },
      // A card held to the right edge inside the column does not move on
      // screen, so it counters the column's travel.
      { anchor: "end", before: bounds(1100, 1400), after: bounds(1100, 1400), parent: 0 },
      // Content riding the column exactly needs no animation of its own.
      { anchor: "center", before: bounds(600, 900), after: bounds(460, 760), parent: 0 },
    ]);
    expect(offsets).toEqual([140, -140, 0]);
  });

  it("contained, holds a column that resizes with the pane at its fixed edge", () => {
    // The sidebar closes over a narrow window: the column fills the pane and
    // widens with it. Gliding its center would start it 128px past the window.
    expect(
      resolvePanelFlipOffsets(
        [{ anchor: "center", before: bounds(313, 960), after: bounds(57, 960), parent: null }],
        { contain: true },
      ),
    ).toEqual([0]);
    // Opening, it narrows: it stays at its new place while the panel covers the rest.
    expect(
      resolvePanelFlipOffsets(
        [{ anchor: "center", before: bounds(57, 960), after: bounds(313, 960), parent: null }],
        { contain: true },
      ),
    ).toEqual([0]);
  });

  it("contained, still glides content of a fixed width by its anchor", () => {
    const offsets = resolvePanelFlipOffsets(
      [
        // A capped column centred in a wider pane.
        { anchor: "center", before: bounds(405, 1173), after: bounds(270, 1038), parent: null },
        // A breadcrumb held to the pane's left edge.
        { anchor: "start", before: bounds(313, 400), after: bounds(57, 144), parent: null },
        // A column that is capped only once the pane widens: it starts no
        // further right than its old right edge.
        { anchor: "center", before: bounds(379, 1199), after: bounds(228, 1081), parent: null },
      ],
      { contain: true },
    );
    expect(offsets).toEqual([135, 256, 118]);
  });

  it("ignores subpixel shifts", () => {
    expect(
      resolvePanelFlipOffsets([
        { anchor: "start", before: bounds(10.3, 20), after: bounds(10, 20), parent: null },
      ]),
    ).toEqual([0]);
  });
});

interface FakeAnimation {
  id: string;
  currentTime: number | null;
  cancelled: boolean;
  readonly from: string;
  cancel(): void;
}

/** A start-anchored element whose layout left the test moves, as React would. */
function fakeElement(left: number) {
  const animations: FakeAnimation[] = [];
  const fake = {
    left,
    isConnected: true,
    dataset: { panelFlip: "start" },
    matches: () => true,
    querySelector: () => null,
    parentElement: null,
    getBoundingClientRect: () => ({
      left: fake.left,
      right: fake.left + 100,
      width: 100,
      height: 20,
    }),
    getAnimations: () => animations.filter((animation) => !animation.cancelled),
    animate: (keyframes: ReadonlyArray<{ transform: string }>) => {
      const animation: FakeAnimation = {
        id: "",
        currentTime: 0,
        cancelled: false,
        from: keyframes[0]!.transform,
        cancel() {
          this.cancelled = true;
        },
      };
      animations.push(animation);
      return animation;
    },
  };
  return fake;
}

describe("playPanelFlip", () => {
  const documentElement = {};
  const resizeCallbacks: Array<(entries: unknown[]) => void> = [];

  beforeAll(() => {
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  /** Runs the frame's resize step and the flip's follow-up microtask. */
  async function runResizeStep() {
    const entry = { target: documentElement, contentRect: { width: 1440, height: 900 } };
    for (const callback of resizeCallbacks) callback([entry]);
    await Promise.resolve();
  }

  const snapshotOf = (
    element: ReturnType<typeof fakeElement>,
    left: number,
  ): PanelFlipSnapshot => ({
    entries: [{ element: element as unknown as HTMLElement, bounds: { left, right: left + 100 } }],
  });

  it("inverts in the committing task, so the first painted frame draws content where it was", async () => {
    const element = fakeElement(56);
    playPanelFlip(snapshotOf(element, 336), 250);
    // Nothing waits for a later callback: the glide already starts at the old place.
    expect(element.getAnimations().map((animation) => animation.from)).toEqual([
      "translateX(280px)",
    ]);
    await runResizeStep();
    expect(element.getAnimations().map((animation) => animation.from)).toEqual([
      "translateX(280px)",
    ]);
  });

  it("retargets content that size-derived state moves in the resize step", async () => {
    const element = fakeElement(56);
    playPanelFlip(snapshotOf(element, 336), 250);
    element.getAnimations()[0]!.currentTime = 16;
    // The resize step re-renders a measured position (the mini player).
    element.left = 100;
    await runResizeStep();
    const [animation] = element.getAnimations();
    expect(animation?.from).toBe("translateX(236px)");
    expect(animation?.currentTime).toBe(16);
  });
});

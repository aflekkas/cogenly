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

  it("contained, glides a column that resizes with the pane by its start edge", () => {
    // The sidebar closes over a narrow window: the column fills the pane and
    // widens with it. Its text keeps its left edge, under the sidebar's
    // moving edge, and the pane clips what reaches past the window meanwhile.
    expect(
      resolvePanelFlipOffsets(
        [{ anchor: "center", before: bounds(313, 960), after: bounds(57, 960), parent: null }],
        { contain: true },
      ),
    ).toEqual([256]);
    // Opening, it narrows: the text keeps its left edge and is pushed along.
    expect(
      resolvePanelFlipOffsets(
        [{ anchor: "center", before: bounds(57, 960), after: bounds(313, 960), parent: null }],
        { contain: true },
      ),
    ).toEqual([-256]);
  });

  it("contained, still glides content of a fixed width by its anchor", () => {
    const offsets = resolvePanelFlipOffsets(
      [
        // A capped column centred in a wider pane.
        { anchor: "center", before: bounds(405, 1173), after: bounds(270, 1038), parent: null },
        // A breadcrumb held to the pane's left edge.
        { anchor: "start", before: bounds(313, 400), after: bounds(57, 144), parent: null },
        // A column that is capped only once the pane widens keeps its left edge.
        { anchor: "center", before: bounds(379, 1199), after: bounds(228, 1081), parent: null },
      ],
      { contain: true },
    );
    expect(offsets).toEqual([135, 256, 151]);
  });

  it("contained to the window, glides resized centred content by its center", () => {
    const window = bounds(0, 1000);
    // Opening over a narrow window: the hero narrows and starts at its old center.
    expect(
      resolvePanelFlipOffsets(
        [
          {
            anchor: "center",
            before: bounds(105, 952),
            after: bounds(344, 935),
            parent: null,
            within: window,
          },
        ],
        { contain: true },
      ),
    ).toEqual([-111]);
    // Closing, it widens; its old center would start it past the window edge.
    expect(
      resolvePanelFlipOffsets(
        [
          {
            anchor: "center",
            before: bounds(361, 952),
            after: bounds(105, 952),
            parent: null,
            within: window,
          },
        ],
        { contain: true },
      ),
    ).toEqual([48]);
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
  playState: "idle" | "paused" | "running";
  readonly from: string;
  readonly finished: Promise<unknown>;
  cancel(): void;
  finish(): void;
  pause(): void;
  play(): void;
}

/** A start-anchored element whose layout left the test moves, as React would. */
function fakeElement(left: number, dataset: Record<string, string> = { panelFlip: "start" }) {
  const animations: FakeAnimation[] = [];
  const fake = {
    left,
    isConnected: true,
    dataset,
    style: {
      visibility: "",
      removeProperty(property: "visibility") {
        this[property] = "";
      },
    },
    matches: () => true,
    querySelector: () => null,
    parentElement: null,
    getBoundingClientRect: () => ({
      left: fake.left,
      right: fake.left + 100,
      width: 100,
      height: 20,
    }),
    getAnimations: () => animations.filter((animation) => animation.playState !== "idle"),
    animate: (keyframes: ReadonlyArray<{ transform: string }>) => {
      let settle!: { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
      const finished = new Promise<unknown>((resolve, reject) => {
        settle = { resolve, reject };
      });
      // A cancelled glide rejects `finished`; nothing awaits it in the tests.
      finished.catch(() => undefined);
      const animation: FakeAnimation = {
        id: "",
        currentTime: 0,
        playState: "running",
        from: keyframes[0]!.transform,
        finished,
        cancel() {
          this.playState = "idle";
          settle.reject(new Error("cancelled"));
        },
        finish() {
          this.playState = "idle";
          settle.resolve(this);
        },
        pause() {
          this.playState = "paused";
        },
        play() {
          this.playState = "running";
        },
      };
      animations.push(animation);
      return animation;
    },
  };
  return fake;
}

describe("playPanelFlip", () => {
  const documentElement = { clientWidth: 1440 };
  const resizeCallbacks: Array<(entries: unknown[]) => void> = [];
  const frameCallbacks: Array<() => void> = [];
  const entering: HTMLElement[] = [];

  beforeAll(() => {
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: () => void) => frameCallbacks.push(callback),
    });
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

  /** The next frame: glides waiting for it start together. */
  function runNextFrame() {
    const callbacks = frameCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }

  const snapshotOf = (
    element: ReturnType<typeof fakeElement>,
    left: number,
  ): PanelFlipSnapshot => ({
    root: { querySelectorAll: () => entering } as unknown as ParentNode,
    entries: [{ element: element as unknown as HTMLElement, bounds: { left, right: left + 100 } }],
  });

  it("inverts in the committing task and starts the glide on the next frame", async () => {
    const element = fakeElement(56);
    playPanelFlip(snapshotOf(element, 336), 250);
    // The commit frame paints content where it was, whatever that frame costs;
    // the motion's first frame is the next one.
    expect(
      element.getAnimations().map((animation) => [animation.from, animation.playState]),
    ).toEqual([["translateX(280px)", "paused"]]);
    await runResizeStep();
    expect(element.getAnimations().map((animation) => animation.playState)).toEqual(["paused"]);
    runNextFrame();
    expect(element.getAnimations().map((animation) => animation.playState)).toEqual(["running"]);
  });

  it("retargets content that size-derived state moves in the resize step", async () => {
    const element = fakeElement(56);
    playPanelFlip(snapshotOf(element, 336), 250);
    runNextFrame();
    element.getAnimations()[0]!.currentTime = 16;
    // The resize step re-renders a measured position (the mini player).
    element.left = 100;
    await runResizeStep();
    const [animation] = element.getAnimations();
    expect(animation?.from).toBe("translateX(236px)");
    expect(animation?.currentTime).toBe(16);
    expect(animation?.playState).toBe("running");
  });

  it("keeps a retargeted glide waiting for the frame that starts the others", async () => {
    const element = fakeElement(56);
    playPanelFlip(snapshotOf(element, 336), 250);
    element.left = 100;
    await runResizeStep();
    expect(element.getAnimations().map((animation) => animation.playState)).toEqual(["paused"]);
    runNextFrame();
    expect(element.getAnimations().map((animation) => animation.playState)).toEqual(["running"]);
  });

  it("brings an entering panel in from the window edge it names", () => {
    const panel = fakeElement(1000, { panelFlip: "start", panelFlipEnter: "end" });
    entering.push(panel as unknown as HTMLElement);
    try {
      playPanelFlip(
        { root: { querySelectorAll: () => entering } as unknown as ParentNode, entries: [] },
        250,
      );
    } finally {
      entering.length = 0;
    }
    expect(panel.getAnimations().map((animation) => animation.from)).toEqual(["translateX(440px)"]);
  });

  it("keeps a panel whose final state hides it visible until its glide ends", async () => {
    const sidebar = fakeElement(-280, { panelFlip: "start", panelFlipVisible: "" });
    playPanelFlip(snapshotOf(sidebar, 0), 250);
    expect(sidebar.style.visibility).toBe("visible");
    // The frame's resize step retargets: the cancelled first glide keeps the hold.
    await runResizeStep();
    await Promise.resolve();
    expect(sidebar.style.visibility).toBe("visible");
    for (const animation of sidebar.getAnimations()) animation.finish();
    await Promise.resolve();
    expect(sidebar.style.visibility).toBe("");
  });

  it("holds a hiding panel visible before it reads style or layout", () => {
    const sidebar = fakeElement(-280, { panelFlip: "start", panelFlipVisible: "" });
    const seen: string[] = [];
    const { getAnimations, getBoundingClientRect } = sidebar;
    sidebar.getAnimations = () => (seen.push(sidebar.style.visibility), getAnimations());
    sidebar.getBoundingClientRect = () => (
      seen.push(sidebar.style.visibility),
      getBoundingClientRect()
    );
    playPanelFlip(snapshotOf(sidebar, 0), 250);
    // Hidden and held land in one style pass, not a hidden pass and then a visible one.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["visible"]));
  });

  it("lets a hiding panel that does not move snap hidden", () => {
    const sidebar = fakeElement(0, { panelFlip: "start", panelFlipVisible: "" });
    playPanelFlip(snapshotOf(sidebar, 0), 250);
    expect(sidebar.getAnimations()).toEqual([]);
    expect(sidebar.style.visibility).toBe("");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const effects = vi.hoisted(() => ({
  cleanups: [] as Array<(() => void) | undefined>,
  resize: undefined as (() => void) | undefined,
  settle: vi.fn(),
}));
vi.mock("react", () => ({
  useLayoutEffect: (effect: () => (() => void) | undefined) => {
    effects.cleanups.push(effect());
  },
}));
vi.mock("~/lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    effects.resize = callback;
    return () => {
      effects.resize = undefined;
    };
  },
}));
vi.mock("~/panelAnimations", () => ({ LAYOUT_MOTION_DURATION: 220 }));
vi.mock("./StateTransition", () => ({ settleFadeSwap: effects.settle }));
// The headline component pulls in the UI kit; this hook only needs its group name.
vi.mock("./HeroHeadline", () => ({ HERO_HEADING_GROUP: "draft-heading" }));

import { useHeroHeadlineMotion as mountHeadline } from "./useHeroHeadlineMotion";

class EffectTarget {
  constructor(public target: unknown) {}
}

class ContentObserver {
  static active = new Set<ContentObserver>();
  constructor(private readonly callback: () => void) {}
  observe() {
    ContentObserver.active.add(this);
  }
  disconnect() {
    ContentObserver.active.delete(this);
  }
  static notify() {
    for (const observer of ContentObserver.active) observer.callback();
  }
}

class Heading {
  static animations: Array<{
    effect: EffectTarget;
    frames: Keyframe[];
    timing: KeyframeAnimationOptions;
    cancel: ReturnType<typeof vi.fn>;
    finished: Promise<void>;
    id: string;
  }> = [];
  static attached: Heading[] = [];
  opacity = "1";
  style = {};
  inert = false;
  constructor(public textContent: string) {}
  cloneNode() {
    return new Heading(this.textContent);
  }
  getBoundingClientRect() {
    return { left: 100, top: 200, width: 800 };
  }
  querySelectorAll() {
    return [];
  }
  getAttributeNames() {
    return [];
  }
  removeAttribute() {}
  setAttribute() {}
  remove() {
    Heading.attached = Heading.attached.filter((copy) => copy !== this);
  }
  animate(frames: Keyframe[], timing: KeyframeAnimationOptions) {
    const animation = {
      effect: new EffectTarget(this),
      frames,
      timing,
      cancel: vi.fn(),
      finished: new Promise<void>(() => {}),
      id: "",
    };
    Heading.animations.push(animation);
    return animation;
  }
}

function mount(heading: Heading) {
  mountHeadline({ current: heading as unknown as HTMLElement }, "chat");
  return effects.cleanups.at(-1)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  Heading.animations = [];
  Heading.attached = [];
  effects.cleanups = [];
  effects.settle.mockClear();
  vi.stubGlobal("MutationObserver", ContentObserver);
  vi.stubGlobal("KeyframeEffect", EffectTarget);
  vi.stubGlobal("document", {
    documentElement: {},
    body: {
      append: (copy: Heading) => {
        Heading.attached.push(copy);
      },
    },
  });
  vi.stubGlobal("getComputedStyle", (heading: Heading) => ({
    opacity: heading.opacity,
    font: "30px Inter",
    letterSpacing: "-0.75px",
    color: "white",
    getPropertyValue: () => "ease-out",
  }));
});

afterEach(() => {
  for (const cleanup of effects.cleanups) cleanup?.();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hero headline content motion", () => {
  it("holds the initial sentence still, including repeated measurements", () => {
    mount(new Heading("Hello · in Spawn Partners"));
    effects.resize?.();
    ContentObserver.notify();
    expect(Heading.animations).toHaveLength(0);
  });

  it("crossfades a project change once, without width or position animation", () => {
    const heading = new Heading("Hello · in Spawn Partners");
    mount(heading);
    heading.textContent = "Hello · in A much longer project name";
    ContentObserver.notify();
    effects.resize?.();
    ContentObserver.notify();
    expect(Heading.animations).toHaveLength(2);
    expect(Heading.animations.map((animation) => animation.frames)).toEqual([
      [{ opacity: 1 }, { opacity: 0 }],
      [{ opacity: 0 }, { opacity: 1 }],
    ]);
    expect(Heading.attached.map((copy) => copy.textContent)).toEqual(["Hello · in Spawn Partners"]);
    expect(Heading.attached[0]?.inert).toBe(true);
  });

  it.each([
    ["Hello", "Hello · in Spawn Partners"],
    ["Hello · in Spawn Partners", "Hello"],
    ["Hello · in Spawn Partners", "A slow Sunday afternoon · in Spawn Partners"],
  ])("fades resolving, removing or loading content: %s", (from, to) => {
    const heading = new Heading(from);
    mount(heading);
    heading.textContent = to;
    ContentObserver.notify();
    expect(Heading.animations).toHaveLength(2);
    expect(Heading.animations[1]?.effect.target).toBe(heading);
  });

  it("does not pop fading text to full opacity during a rapid second pick", () => {
    const heading = new Heading("Hello · in Spawn Partners");
    mount(heading);
    heading.textContent = "Hello · in Second project";
    ContentObserver.notify();
    heading.opacity = "0.4";
    heading.textContent = "Hello · in Third project";
    ContentObserver.notify();
    expect(Heading.animations).toHaveLength(4);
    expect(Heading.animations[2]?.frames).toEqual([{ opacity: 0.4 }, { opacity: 0 }]);
    expect(Heading.animations[0]?.cancel).not.toHaveBeenCalled();
    expect(Heading.attached).toHaveLength(2);
  });

  it("continues the same fade on a replacing draft instead of starting another", () => {
    const heading = new Heading("Hello · in Spawn Partners");
    const unmount = mount(heading);
    heading.textContent = "Hello · in Another project";
    ContentObserver.notify();
    const incoming = Heading.animations[1]!;
    unmount();
    const replacement = new Heading(heading.textContent);
    mount(replacement);
    vi.runAllTimers();
    expect(Heading.animations).toHaveLength(2);
    expect(incoming.effect.target).toBe(replacement);
    expect(incoming.cancel).not.toHaveBeenCalled();
    expect(effects.settle).toHaveBeenCalledWith("draft-heading");
  });

  it("removes leaving copies and cancels motion when the hero is left", () => {
    const heading = new Heading("Hello");
    const unmount = mount(heading);
    heading.textContent = "Hello · in Spawn Partners";
    ContentObserver.notify();
    unmount();
    vi.runAllTimers();
    expect(Heading.attached).toHaveLength(0);
    expect(Heading.animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(
      true,
    );
  });
});

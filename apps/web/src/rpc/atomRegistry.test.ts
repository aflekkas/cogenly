import { Atom } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeRenderSafeAtomRegistry } from "./atomRegistry";

// An atom whose first build writes another atom, like an effect or stream atom
// that publishes into shared state as it starts.
const makeAtoms = () => {
  const shared = Atom.make(0);
  const builder = Atom.make((get) => {
    get.set(shared, 1);
    return "built";
  });
  return { shared, builder };
};

describe("makeRenderSafeAtomRegistry", () => {
  it("holds a change raised while a read builds an atom until the read returns", async () => {
    const registry = makeRenderSafeAtomRegistry();
    const { shared, builder } = makeAtoms();
    const heard: number[] = [];
    registry.subscribe(shared, (value) => heard.push(value));

    // A component reading `builder` in render must not update `shared`'s subscribers.
    expect(registry.get(builder)).toBe("built");
    expect(heard).toEqual([]);

    await Promise.resolve();
    expect(heard).toEqual([1]);
  });

  it("delivers each held listener once with its latest value", async () => {
    const registry = makeRenderSafeAtomRegistry();
    const shared = Atom.make(0);
    const builder = Atom.make((get) => {
      get.set(shared, 1);
      get.set(shared, 2);
      return "built";
    });
    const heard: number[] = [];
    registry.subscribe(shared, (value) => heard.push(value));

    registry.get(builder);
    await Promise.resolve();
    expect(heard).toEqual([2]);
  });

  it("notifies at once outside a read and calls immediate subscribers synchronously", () => {
    const registry = makeRenderSafeAtomRegistry();
    const { shared } = makeAtoms();
    const heard: number[] = [];
    registry.subscribe(shared, (value) => heard.push(value), { immediate: true });
    registry.set(shared, 5);
    expect(heard).toEqual([0, 5]);
  });

  it("drops a held change for a listener that unsubscribed", async () => {
    const registry = makeRenderSafeAtomRegistry();
    const { shared, builder } = makeAtoms();
    const heard: number[] = [];
    const release = registry.subscribe(shared, (value) => heard.push(value));

    registry.get(builder);
    release();
    await Promise.resolve();
    expect(heard).toEqual([]);
  });
});

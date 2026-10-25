import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { use, useLayoutEffect, useState } from "react";

/**
 * Reads an atom like `useAtomValue`, except that an atom nobody has built yet
 * is built from a layout effect rather than during render, with `fallback`
 * read for that one render. Building an effect or stream atom runs its fiber
 * synchronously and drains the registry's queue, which can update other
 * atoms; doing that in render makes React warn that a component updated while
 * another was rendering. The built value replaces the fallback before paint.
 */
export function useAtomValueBuiltOutsideRender<A>(atom: Atom.Atom<A>, fallback: Atom.Atom<A>): A {
  const registry = use(RegistryContext);
  const built = registry.getNodes().has(atom);
  // Re-renders once the layout effect has built an atom the render skipped.
  const [, setMounted] = useState<Atom.Atom<A> | null>(null);
  useLayoutEffect(() => {
    const release = registry.mount(atom);
    // oxlint-disable-next-line react/set-state-in-effect -- The build has to happen outside render; this reads it before paint.
    setMounted(atom);
    return release;
  }, [atom, registry]);
  return useAtomValue(built ? atom : fallback);
}

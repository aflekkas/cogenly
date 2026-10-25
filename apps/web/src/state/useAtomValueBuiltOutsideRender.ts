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

/**
 * Reads a composite atom made in render, one that combines `sources` (such
 * as one live stream per environment). Deriving from built sources writes
 * nothing, so it is read in render once every source is built. A source
 * nobody has built yet would run its fiber during render, so it is built from
 * a layout effect instead, and until then this reads the composite it last
 * read in full (`fallback` the first time). `sources` must be stable while it
 * lists the same atoms.
 */
export function useAtomValueOverBuiltSources<A>(
  atom: Atom.Atom<A>,
  sources: ReadonlyArray<Atom.Atom<unknown>>,
  fallback: Atom.Atom<A>,
): A {
  const registry = use(RegistryContext);
  const nodes = registry.getNodes();
  const ready = sources.every((source) => nodes.has(source));
  // The last composite read with its sources built: deriving it again writes nothing.
  const [lastReady, setLastReady] = useState<Atom.Atom<A> | null>(null);
  if (ready && lastReady !== atom) setLastReady(atom);
  // Re-renders once the layout effect has built the sources the render skipped.
  const [, setBuilt] = useState<ReadonlyArray<Atom.Atom<unknown>> | null>(null);
  useLayoutEffect(() => {
    const unbuilt = sources.filter((source) => !registry.getNodes().has(source));
    if (unbuilt.length === 0) return;
    const releases = unbuilt.map((source) => registry.mount(source));
    // oxlint-disable-next-line react/set-state-in-effect -- The build has to happen outside render; this reads it before paint.
    setBuilt(sources);
    return () => {
      for (const release of releases) release();
    };
  }, [registry, sources]);
  return useAtomValue(ready ? atom : (lastReady ?? fallback));
}

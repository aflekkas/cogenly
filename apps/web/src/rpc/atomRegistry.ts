import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry, type Atom } from "effect/reactivity";
import { createElement } from "react";

/**
 * Makes a registry whose subscribers never hear a change raised while a read
 * is building an atom. React components read atoms in render through
 * `registry.get`; reading an effect or stream atom for the first time builds
 * it, and building it can synchronously write atoms other mounted components
 * subscribe to. Notifying them then updates those components while another one
 * renders, which React rejects. Changes raised inside `get` or `subscribe` are
 * held and delivered in a microtask instead, each listener once with its
 * latest value, so every hook reading through the registry is covered.
 */
export function makeRenderSafeAtomRegistry(
  options?: Parameters<typeof AtomRegistry.make>[0],
): AtomRegistry.AtomRegistry {
  const registry = AtomRegistry.make(options);
  const get = registry.get.bind(registry);
  const subscribe = registry.subscribe.bind(registry);
  let readDepth = 0;
  // Held listeners and the latest value each was notified with.
  const held = new Map<(value: never) => void, unknown>();
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    const listeners = [...held];
    held.clear();
    for (const [listener, value] of listeners) listener(value as never);
  };

  const reading = <A>(read: () => A): A => {
    readDepth++;
    try {
      return read();
    } finally {
      readDepth--;
    }
  };

  Object.assign(registry, {
    get: <A>(atom: Atom.Atom<A>) => reading(() => get(atom)),
    subscribe: <A>(
      atom: Atom.Atom<A>,
      f: (value: A) => void,
      options?: { readonly immediate?: boolean },
    ) => {
      let active = true;
      // The `immediate` call is this subscriber's own first read, not a change.
      let subscribing = true;
      const deliver = (value: A) => {
        if (active) f(value);
      };
      const listener = (value: A) => {
        if (subscribing || readDepth === 0) {
          held.delete(deliver);
          f(value);
          return;
        }
        held.set(deliver, value);
        if (!flushScheduled) {
          flushScheduled = true;
          queueMicrotask(flush);
        }
      };
      const release = reading(() => subscribe(atom, listener, options));
      subscribing = false;
      return () => {
        active = false;
        held.delete(deliver);
        release();
      };
    },
  } satisfies Pick<AtomRegistry.AtomRegistry, "get" | "subscribe">);
  return registry;
}

export const appAtomRegistry = makeRenderSafeAtomRegistry();

export function AppAtomRegistryProvider({ children }: React.PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}

import { type ComponentType, createElement, lazy } from "react";

/**
 * A code-split component that renders synchronously once its module has
 * loaded. `React.lazy` alone suspends on the first render even when the
 * chunk is already in memory, and a Suspense boundary that showed its
 * fallback reveals the content only after React's throttle window, so a
 * prefetched panel would still pop in a few hundred milliseconds after it
 * mounts. Call `preload` ahead of time (while the surface that will show it
 * is on screen); until it resolves, rendering falls back to the lazy path.
 */
export function preloadableComponent<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): { Component: ComponentType<Props>; preload: () => Promise<void> } {
  let loaded: ComponentType<Props> | null = null;
  let loading: Promise<void> | null = null;
  const preload = () => {
    loading ??= load().then((component) => {
      loaded = component;
    });
    return loading;
  };
  const Lazy = lazy(() => preload().then(() => ({ default: loaded! })));
  // Reads module state that changes outside React, so the compiler must not
  // cache the element; createElement keeps the loaded component a component
  // (the JSX form was compiled to a string tag).
  const Component = (props: Props) => {
    "use no memo";
    return createElement(loaded ?? Lazy, props);
  };
  return { Component, preload };
}

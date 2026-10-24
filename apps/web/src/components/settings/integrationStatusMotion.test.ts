import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createIntegrationStatusFade } from "./integrationStatusMotion";

afterEach(() => vi.unstubAllGlobals());

describe("integration status motion", () => {
  it("fades only changes, cancels superseded fades, and cleans up on unmount", () => {
    const active = new Set<unknown>();
    const animate = vi.fn(() => {
      const animation = { cancel: () => active.delete(animation) };
      active.add(animation);
      return animation;
    });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (key: string) => (key === "--motion-duration-base" ? "220ms" : "ease-out"),
    }));
    const fade = createIntegrationStatusFade({ animate } as unknown as HTMLElement);
    fade.update("Connected");
    fade.update("Connected");
    expect(active.size).toBe(0);
    fade.update("Needs sign-in");
    expect(active.size).toBe(1);
    fade.update("Error");
    expect(active.size).toBe(1);
    fade.update("Error");
    expect(animate).toHaveBeenCalledTimes(2);
    // Opacity alone is also the reduced-motion path: there is no spatial movement.
    expect(animate.mock.calls[0]).toEqual([
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 220, easing: "ease-out" },
    ]);
    fade.dispose();
    expect(active.size).toBe(0);
  });
});

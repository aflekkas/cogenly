// @effect-diagnostics nodeBuiltinImport:off - Drives the page binding and clock without Chrome.
import * as NodeEvents from "node:events";
import type { Page } from "playwright-core";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { watchPopupPreferredSize } from "./ServerBrowserPopupSize.ts";

afterEach(() => vi.useRealTimers());

it("coalesces binding floods, serializes resizes, and cancels pending work on stop", async () => {
  vi.useFakeTimers();
  let report!: (source: unknown, size: unknown) => Promise<void>;
  const page = Object.assign(new NodeEvents.EventEmitter(), {
    exposeBinding: async (_key: string, callback: typeof report) => {
      report = callback;
    },
    evaluate: async () => {},
  });
  const first = Promise.withResolvers<void>();
  const resize = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const stop = await watchPopupPreferredSize(page as unknown as Page, resize);
  for (let width = 100; width < 500; width++) await report({}, { width, height: 180 });
  await vi.advanceTimersByTimeAsync(0);
  expect(resize.mock.calls).toEqual([[{ width: 499, height: 180 }]]);
  await report({}, { width: 600, height: 200 });
  await report({}, { width: 700, height: 240 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(resize).toHaveBeenCalledTimes(1);
  first.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(resize).toHaveBeenLastCalledWith({ width: 700, height: 240 });
  await report({}, { width: Infinity, height: 240 });
  await report({}, { width: 900, height: 900 });
  await stop();
  await vi.runAllTimersAsync();
  expect(resize).toHaveBeenCalledTimes(2);
});

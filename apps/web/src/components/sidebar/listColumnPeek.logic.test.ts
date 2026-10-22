import { describe, expect, it } from "vite-plus/test";

import { PANEL_ANIMATION_DURATION } from "../../panelAnimations";
import {
  LIST_COLUMN_PEEK_IDLE,
  LIST_COLUMN_PEEK_SETTLE_MS,
  LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS,
  listColumnPeekAvailable,
  listColumnPeekDismissedByNavigation,
  reduceListColumnPeek,
  resolveListColumnPeekSurface,
  type ListColumnPeekEvent,
  listColumnPeekDelayMs,
  type ListColumnPeekState,
} from "./listColumnPeek.logic";

function run(...events: ListColumnPeekEvent[]): ListColumnPeekState {
  return events.reduce(reduceListColumnPeek, LIST_COLUMN_PEEK_IDLE);
}

const enter = { type: "pointer-enter" } as const;
const leave = { type: "pointer-leave" } as const;
const timer = { type: "timer" } as const;
const hold = (held: boolean) => ({ type: "hold", held }) as const;

describe("reduceListColumnPeek", () => {
  it("opens only after the hover intent delay", () => {
    const intent = run(enter);
    expect(intent.phase).toBe("closed");
    expect(intent.pending).toBe("open");
    expect(resolveListColumnPeekSurface(intent)).toBe("closed");
    expect(run(enter, timer).phase).toBe("open");
  });

  it("does nothing when the pointer only passes over the toggle", () => {
    const passed = run(enter, leave);
    expect(passed).toMatchObject({ phase: "closed", pending: null });
    expect(resolveListColumnPeekSurface(passed)).toBeUndefined();
  });

  it("stays open crossing from the toggle into the overlay", () => {
    const crossed = run(enter, timer, leave, enter);
    expect(crossed).toMatchObject({ phase: "open", pending: null, hovering: true });
  });

  it("closes after the grace delay, then settles once the motion ends", () => {
    const left = run(enter, timer, leave);
    expect(left).toMatchObject({ phase: "open", pending: "close" });
    const closing = reduceListColumnPeek(left, timer);
    expect(closing).toMatchObject({ phase: "closing", pending: "settle" });
    expect(resolveListColumnPeekSurface(closing)).toBe("closed");
    const settled = reduceListColumnPeek(closing, timer);
    expect(settled).toMatchObject({ phase: "closed", pending: null });
    expect(resolveListColumnPeekSurface(settled)).toBeUndefined();
  });

  it("reopens when the pointer comes back while it is closing", () => {
    const back = run(enter, timer, leave, timer, enter);
    expect(back).toMatchObject({ phase: "closing", pending: "open" });
    expect(reduceListColumnPeek(back, timer).phase).toBe("open");
    // Leaving again before the intent delay lets the close finish.
    expect(reduceListColumnPeek(back, leave)).toMatchObject({
      phase: "closing",
      pending: "settle",
    });
  });

  it("stays open while held, and closes once released away from it", () => {
    const held = run(enter, timer, hold(true), leave);
    expect(held).toMatchObject({ phase: "open", pending: null });
    expect(reduceListColumnPeek(held, hold(false))).toMatchObject({
      phase: "open",
      pending: "close",
    });
  });

  it("a hold cancels a close already counting down", () => {
    const counting = run(enter, timer, leave);
    expect(reduceListColumnPeek(counting, hold(true)).pending).toBeNull();
  });

  it("releasing the hold while hovering keeps it open", () => {
    expect(run(enter, timer, hold(true), hold(false))).toMatchObject({
      phase: "open",
      pending: null,
    });
  });

  it("a hold while closed does not open it", () => {
    expect(run(hold(true))).toMatchObject({ phase: "closed", pending: null, held: true });
  });

  it("dismiss closes at once, even while hovering or held", () => {
    const dismissed = run(enter, timer, hold(true), { type: "dismiss" });
    expect(dismissed).toMatchObject({ phase: "closing", pending: "settle", hovering: false });
    expect(run(enter, { type: "dismiss" })).toMatchObject({ phase: "closed", pending: null });
  });

  it("an outside press closes it at once, unless the search or a menu holds it", () => {
    const outside = { type: "outside-press" } as const;
    expect(run(enter, timer, leave, outside)).toMatchObject({
      phase: "closing",
      pending: "settle",
    });
    expect(run(enter, timer, hold(true), outside)).toMatchObject({ phase: "open" });
    expect(run(enter, outside)).toMatchObject({ phase: "closed", pending: null });
  });

  it("reset drops everything", () => {
    expect(run(enter, timer, { type: "reset" })).toBe(LIST_COLUMN_PEEK_IDLE);
  });
});

describe("listColumnPeekAvailable", () => {
  const base = { navRailVisible: true, listColumnOpen: false, listColumnHidden: false };

  it("offers the peek wherever the rail's column is collapsed", () => {
    expect(listColumnPeekAvailable(base)).toBe(true);
  });

  it("is off with the column docked, hidden by the route, or without the rail", () => {
    expect(listColumnPeekAvailable({ ...base, listColumnOpen: true })).toBe(false);
    expect(listColumnPeekAvailable({ ...base, listColumnHidden: true })).toBe(false);
    expect(listColumnPeekAvailable({ ...base, navRailVisible: false })).toBe(false);
  });
});

describe("listColumnPeekDismissedByNavigation", () => {
  it("closes for a route change that follows a click inside the column", () => {
    expect(listColumnPeekDismissedByNavigation(1000, 1200)).toBe(true);
    expect(
      listColumnPeekDismissedByNavigation(1000, 1001 + LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS),
    ).toBe(false);
    expect(listColumnPeekDismissedByNavigation(null, 1200)).toBe(false);
  });

  it("holds the overlay styles until the close has run its full panel duration", () => {
    expect(LIST_COLUMN_PEEK_SETTLE_MS).toBe(PANEL_ANIMATION_DURATION);
    expect(listColumnPeekDelayMs("settle")).toBe(PANEL_ANIMATION_DURATION);
  });
});

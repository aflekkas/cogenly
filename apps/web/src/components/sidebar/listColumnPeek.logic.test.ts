import { describe, expect, it } from "vite-plus/test";

import {
  LIST_COLUMN_PEEK_IDLE,
  LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS,
  listColumnPeekAvailable,
  listColumnPeekDismissedByNavigation,
  reduceListColumnPeek,
  resolveListColumnPeekSurface,
  type ListColumnPeekEvent,
  type ListColumnPeekState,
} from "./listColumnPeek.logic";

function run(...events: ListColumnPeekEvent[]): ListColumnPeekState {
  return events.reduce(reduceListColumnPeek, LIST_COLUMN_PEEK_IDLE);
}

const open = { type: "open" } as const;
const toggle = { type: "toggle" } as const;
const outside = { type: "outside-press" } as const;
const dismiss = { type: "dismiss" } as const;
const timer = { type: "timer" } as const;
const hold = (held: boolean) => ({ type: "hold", held }) as const;

describe("reduceListColumnPeek", () => {
  it("opens only on a deliberate action, painting the hidden state first", () => {
    const opening = run(open);
    expect(opening).toMatchObject({ phase: "closed", pending: "open" });
    expect(resolveListColumnPeekSurface(opening)).toBe("closed");
    expect(run(open, timer).phase).toBe("open");
    expect(resolveListColumnPeekSurface(run(open, timer))).toBe("open");
    expect(run(toggle, timer).phase).toBe("open");
  });

  it("stays open with no close timer of its own", () => {
    const opened = run(open, timer);
    expect(opened.pending).toBeNull();
    // A stray timer tick changes nothing.
    expect(reduceListColumnPeek(opened, timer)).toBe(opened);
  });

  it("closes on dismiss, the toggle again or an outside press, then settles", () => {
    for (const close of [dismiss, toggle, outside]) {
      const closing = run(open, timer, close);
      expect(closing).toMatchObject({ phase: "closing", pending: "settle" });
      expect(resolveListColumnPeekSurface(closing)).toBe("closed");
      const settled = reduceListColumnPeek(closing, timer);
      expect(settled).toMatchObject({ phase: "closed", pending: null });
      expect(resolveListColumnPeekSurface(settled)).toBeUndefined();
    }
  });

  it("an outside press leaves it open while the search or a menu holds it", () => {
    const held = run(open, timer, hold(true), outside);
    expect(held).toMatchObject({ phase: "open", pending: null });
    expect(run(open, timer, hold(true), hold(false), outside).phase).toBe("closing");
  });

  it("dismiss and the toggle close it even while held", () => {
    expect(run(open, timer, hold(true), dismiss).phase).toBe("closing");
    expect(run(open, timer, hold(true), toggle).phase).toBe("closing");
  });

  it("opening again while it closes slides it back out", () => {
    const back = run(open, timer, dismiss, open);
    expect(back).toMatchObject({ phase: "closing", pending: "open" });
    expect(reduceListColumnPeek(back, timer).phase).toBe("open");
  });

  it("a toggle before it is out cancels the open", () => {
    expect(run(open, toggle)).toMatchObject({ phase: "closed", pending: null });
    expect(resolveListColumnPeekSurface(run(open, toggle))).toBeUndefined();
  });

  it("does nothing on an outside press or dismiss while closed", () => {
    expect(run(outside)).toBe(LIST_COLUMN_PEEK_IDLE);
    expect(run(dismiss)).toBe(LIST_COLUMN_PEEK_IDLE);
  });

  it("a hold while closed does not open it", () => {
    expect(run(hold(true))).toMatchObject({ phase: "closed", pending: null, held: true });
  });

  it("reset drops everything", () => {
    expect(run(open, timer, { type: "reset" })).toBe(LIST_COLUMN_PEEK_IDLE);
  });
});

describe("listColumnPeekAvailable", () => {
  const base = {
    navRailVisible: true,
    listColumnOpen: false,
    listColumnHidden: false,
    navRailWidth: 57,
    listColumnWidth: 256,
    rightPanelWidth: null,
  };

  it("offers the overlay where an open column would cramp the main column", () => {
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1100 })).toBe(true);
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1600 })).toBe(false);
  });

  it("counts an inline right panel against the room", () => {
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1600, rightPanelWidth: 480 })).toBe(
      true,
    );
  });

  it("is off with the column open, hidden by the route, or without the rail", () => {
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1000, listColumnOpen: true })).toBe(
      false,
    );
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1000, listColumnHidden: true })).toBe(
      false,
    );
    expect(listColumnPeekAvailable({ ...base, viewportWidth: 1000, navRailVisible: false })).toBe(
      false,
    );
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
});

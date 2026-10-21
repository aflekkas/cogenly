import { describe, expect, it } from "@effect/vitest";

import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (cause: unknown) => (cause instanceof BrowserControlInterrupted ? cause.reason : "other"),
  );

describe("SessionControl", () => {
  it("lets an agent action take control back from a person driving the tab", async () => {
    const order: Array<string> = [];
    const control = new SessionControl("agent-1", {
      onDisplaced: async (viewerId) => {
        order.push(`released ${viewerId}`);
      },
    });
    await control.take("viewer-1");
    expect(control.controller).toBe("viewer-1");
    expect(control.agentDrives).toBe(false);

    const result = await control.agent("agent-1", async () => {
      order.push("agent acted");
      return "done";
    });

    expect(result).toBe("done");
    expect(control.controller).toBeNull();
    expect(control.agentDrives).toBe(true);
    // The person's held keys and buttons let go before the agent acts.
    expect(order).toEqual(["released viewer-1", "agent acted"]);
  });

  it("claims a person's own tab for whichever agent acts on it", async () => {
    const control = new SessionControl(null);
    await control.take("viewer-1");
    await control.agent("agent-1", async () => {});
    expect(control.controller).toBeNull();
    expect(control.agentDrives).toBe(true);
    // Taking it back makes it the person's again.
    await control.take("viewer-1");
    expect(control.agentDrives).toBe(false);
  });

  it("interrupts the person's queued input when an agent takes control mid-gesture", async () => {
    const control = new SessionControl("agent-1");
    await control.take("viewer-1");
    const pressing = deferred();
    const pressStarted = deferred();
    const press = control.human("viewer-1", () => {
      pressStarted.resolve();
      return pressing.promise;
    });
    const move = control.human("viewer-1", async () => {});
    await pressStarted.promise;
    const acting = control.agent("agent-1", async () => "acted");
    pressing.resolve();

    await press;
    expect(await reasonOf(move)).toBe("interrupted");
    expect(await acting).toBe("acted");
  });

  it("interrupts queued agent actions when a person takes control, after the running one drains", async () => {
    const control = new SessionControl("agent-1");
    const running = deferred();
    const order: Array<string> = [];
    const started = deferred();
    const first = control.agent("agent-1", async () => {
      started.resolve();
      await running.promise;
      order.push("first finished");
    });
    const second = reasonOf(
      control.agent("agent-1", async () => {
        order.push("second ran");
      }),
    );
    await started.promise;

    const taking = control.take("viewer-1").then(() => order.push("viewer has control"));
    expect(control.controller).toBe("viewer-1");
    running.resolve();

    await first;
    expect(await second).toBe("interrupted");
    await taking;
    expect(order).toEqual(["first finished", "viewer has control"]);
  });

  it("lets a viewer take over from another viewer", async () => {
    const released: Array<string> = [];
    const control = new SessionControl(null, {
      onDisplaced: async (viewerId) => {
        released.push(viewerId);
      },
    });
    await control.take("viewer-1");
    await control.take("viewer-2");
    expect(control.controller).toBe("viewer-2");
    expect(released).toEqual(["viewer-1"]);
    expect(await reasonOf(control.human("viewer-1", async () => {}))).toBe("interrupted");
  });

  it("still refuses an agent acting on another agent's tab", async () => {
    const control = new SessionControl("agent-1");
    await control.take("viewer-1");
    expect(await reasonOf(control.agent("agent-2", async () => {}))).toBe("agentMismatch");
    expect(control.controller).toBe("viewer-1");
  });
});

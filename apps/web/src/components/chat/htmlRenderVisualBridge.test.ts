import { VisualStateError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isVisualSnapshotNews,
  readVisualBridgeRequest,
  visualBridgeErrorReply,
  visualSnapshot,
} from "./htmlRenderVisualBridge";

const request = (method: string, params: unknown, id: string | number = "cogenly-1") => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("readVisualBridgeRequest", () => {
  it("routes each bridge method with its params", () => {
    expect(readVisualBridgeRequest(request("t3/visual-state.get", {}))).toEqual({
      kind: "get",
      id: "cogenly-1",
    });
    expect(
      readVisualBridgeRequest(
        request("t3/visual-state.set", { state: { answers: [1] }, expectedVersion: 2.7 }, 4),
      ),
    ).toEqual({ kind: "set", id: 4, state: { answers: [1] }, expectedVersion: 2 });
    expect(
      readVisualBridgeRequest(request("t3/visual.submit", { payload: { score: 3 }, lock: true })),
    ).toEqual({ kind: "submit", id: "cogenly-1", payload: { score: 3 }, lock: true });
  });

  it("ignores other frame traffic and malformed requests", () => {
    expect(
      readVisualBridgeRequest({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 10 },
      }),
    ).toBeUndefined();
    expect(
      readVisualBridgeRequest({ jsonrpc: "2.0", method: "t3/visual-state.get", params: {} }),
    ).toBeUndefined();
    expect(
      readVisualBridgeRequest(request("t3/visual-state.set", { state: {}, expectedVersion: "1" })),
    ).toBeUndefined();
    expect(readVisualBridgeRequest("t3/visual-state.get")).toBeUndefined();
  });

  it("only locks a submit that asks for it", () => {
    expect(
      readVisualBridgeRequest(request("t3/visual.submit", { payload: 1, lock: "yes" })),
    ).toEqual({ kind: "submit", id: "cogenly-1", payload: 1, lock: false });
  });
});

describe("visualSnapshot", () => {
  it("starts at version 0 before the first write", () => {
    expect(visualSnapshot(null)).toEqual({ state: null, version: 0, locked: false });
    expect(visualSnapshot({ state: undefined, version: 3, locked: true })).toEqual({
      state: null,
      version: 3,
      locked: true,
    });
  });
});

describe("isVisualSnapshotNews", () => {
  it("pushes newer versions and a new lock once", () => {
    expect(isVisualSnapshotNews(null, { version: 1, locked: false })).toBe(true);
    expect(isVisualSnapshotNews({ version: 2, locked: false }, { version: 3, locked: false })).toBe(
      true,
    );
    expect(isVisualSnapshotNews({ version: 3, locked: false }, { version: 3, locked: true })).toBe(
      true,
    );
  });

  it("drops a projection update that trails the frame's own round-trip", () => {
    expect(isVisualSnapshotNews({ version: 3, locked: false }, { version: 3, locked: false })).toBe(
      false,
    );
    expect(isVisualSnapshotNews({ version: 4, locked: false }, { version: 3, locked: false })).toBe(
      false,
    );
    expect(isVisualSnapshotNews({ version: 3, locked: true }, { version: 3, locked: true })).toBe(
      false,
    );
  });
});

describe("visualBridgeErrorReply", () => {
  it("keeps the reason a page can act on and the version that won", () => {
    const reply = visualBridgeErrorReply(
      "cogenly-2",
      new VisualStateError({
        operation: "set",
        reason: "version_conflict",
        renderId: "render-1",
        expectedVersion: 1,
        actualVersion: 2,
      }),
    );
    expect(reply).toMatchObject({
      jsonrpc: "2.0",
      id: "cogenly-2",
      error: { data: { reason: "version_conflict", currentVersion: 2 } },
    });
    expect(reply.error.message).toContain("changed since version 1");
    expect(
      visualBridgeErrorReply(
        7,
        new VisualStateError({ operation: "submit", reason: "locked", renderId: "render-1" }),
      ).error.data,
    ).toEqual({ reason: "locked" });
    expect(
      visualBridgeErrorReply(
        7,
        new VisualStateError({ operation: "set", reason: "too_large", renderId: "render-1" }),
      ).error.data,
    ).toEqual({ reason: "too_large" });
  });

  it("reports storage, authorization and transport failures as unavailable", () => {
    expect(
      visualBridgeErrorReply(
        1,
        new VisualStateError({ operation: "get", reason: "storage", renderId: "render-1" }),
      ).error.data,
    ).toEqual({ reason: "unavailable" });
    expect(visualBridgeErrorReply(1, new Error("socket closed")).error).toMatchObject({
      message: "socket closed",
      data: { reason: "unavailable" },
    });
    expect(visualBridgeErrorReply(1, undefined).error.message).toBe("The visual request failed.");
  });
});

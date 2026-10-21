import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { DeviceHubAccess } from "../device/hubAccess.ts";
import {
  createPreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamEvents,
  type PreviewStreamPickHover,
} from "./serverBrowserStream.ts";

type Listener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: Array<FakeWebSocket> = [];
  readonly sent: Array<string> = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  private readonly listeners = new Map<string, Array<Listener>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  serverMessage(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

const access: DeviceHubAccess = {
  httpBase: "https://env.example/api/preview-stream",
  wsBase: "wss://env.example/api/preview-stream",
  query: {},
  credentials: false,
};

const installWebSocket = () => {
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>)["WebSocket"] = FakeWebSocket;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>)["WebSocket"];
});

const connect = (events: Partial<PreviewStreamEvents> = {}) => {
  installWebSocket();
  const client = createPreviewStreamClient(
    { access, threadId: "thread_1", tabId: "tab_1", maxWidth: 800, maxHeight: 600 },
    {
      onFrame: () => {},
      onViewport: () => {},
      onConnectedChange: () => {},
      onUnauthorized: () => {},
      ...events,
    },
  );
  const socket = FakeWebSocket.instances[0]!;
  socket.emit("open");
  return { client, socket };
};

const controlMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "control",
  canOperate: true,
  controller: "agent",
  generation: 3,
  dialog: null,
  ...overrides,
});

describe("preview stream pick protocol", () => {
  it("parses capabilities on control", () => {
    const controls: Array<PreviewStreamControl> = [];
    const { socket } = connect({
      onControl: (control: PreviewStreamControl) => controls.push(control),
    });
    socket.serverMessage(controlMessage({ capabilities: { pick: true } }));
    expect(controls).toEqual([
      {
        canOperate: true,
        controller: "agent",
        generation: 3,
        capabilities: { pick: true },
        dialog: null,
      },
    ]);
    // Older servers omit capabilities; the flag reads as unsupported.
    socket.serverMessage(controlMessage({ capabilities: undefined }));
    expect(controls[1]).not.toHaveProperty("capabilities");
  });

  it("delivers hover, result, and error events", () => {
    const hovers: Array<PreviewStreamPickHover> = [];
    const results: Array<PreviewAnnotationPayload> = [];
    const errors: Array<string> = [];
    const { socket } = connect({
      onPickHover: (hover: PreviewStreamPickHover) => hovers.push(hover),
      onPickResult: (annotation: PreviewAnnotationPayload) => results.push(annotation),
      onPickError: (message: string) => errors.push(message),
    });
    socket.serverMessage({
      type: "pickHover",
      box: { x: 1, y: 2, width: 3, height: 4 },
      label: 'button "Buy"',
    });
    socket.serverMessage({ type: "pickHover", box: null, label: null });
    socket.serverMessage({ type: "pickHover", box: { x: 0 }, label: null });
    expect(hovers).toEqual([
      { box: { x: 1, y: 2, width: 3, height: 4 }, label: 'button "Buy"' },
      { box: null, label: null },
    ]);
    const annotation = { id: "annotation_1" };
    socket.serverMessage({ type: "pickResult", annotation });
    socket.serverMessage({ type: "pickResult", annotation: null });
    expect(results).toEqual([annotation]);
    socket.serverMessage({ type: "pickError", message: "No element there." });
    expect(errors).toEqual(["No element there."]);
  });

  it("sends picks without control but holds driving input", () => {
    const { client, socket } = connect();
    socket.serverMessage(controlMessage({ capabilities: { pick: true } }));
    expect(client.send({ type: "pickHitTest", x: 1, y: 2 })).toBe(true);
    expect(client.send({ type: "pickCommit", x: 1, y: 2 })).toBe(true);
    expect(client.send({ type: "pickCommitRegion", x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(
      client.send({
        type: "mouse",
        action: "move",
        x: 1,
        y: 2,
        button: "none",
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
      }),
    ).toBe(false);
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual([
      "pickHitTest",
      "pickCommit",
      "pickCommitRegion",
    ]);
  });

  it("drops picks for read-only viewers", () => {
    const { client, socket } = connect();
    socket.serverMessage(controlMessage({ canOperate: false }));
    expect(client.send({ type: "pickHitTest", x: 1, y: 2 })).toBe(false);
    expect(socket.sent).toEqual([]);
  });
});

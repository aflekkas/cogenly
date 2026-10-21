import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";

import {
  captureElementPick,
  capturePickScreenshot,
  captureRegionPick,
  createPickHitTestQueue,
  describePickRequest,
  hitTestElement,
  PICK_ELEMENT_SOURCE,
  PICK_HIT_TEST_SOURCE,
  PickCaptureError,
  type PickCdpSession,
  type PickPage,
} from "./ServerBrowserPick.ts";

const evaluateResponse = (value: unknown) => ({ result: { value } });

const fakeCdp = (
  respond: (method: string, params?: Record<string, unknown>) => unknown,
  seen: Array<string> = [],
): PickCdpSession => ({
  send: async (method, params) => {
    seen.push(method);
    return respond(method, params);
  },
});

const fakePage = (overrides?: Partial<PickPage>): PickPage => ({
  url: () => "https://example.com/",
  title: async () => "Example",
  viewportSize: () => ({ width: 1280, height: 800 }),
  ...overrides,
});

let idSequence = 0;
const testIds = () => ({
  newId: () => `id_${(idSequence += 1)}`,
  nowIso: () => "2026-10-21T00:00:00.000Z",
});

/** First 33 bytes of a PNG with the given IHDR size, base64-encoded. */
const pngBytes = (width: number, height: number): string => {
  const bytes = Buffer.alloc(33, 0);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
};

const flushMicrotasks = async (rounds = 30) => {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
};

describe("page scripts", () => {
  it("compile as page expressions", () => {
    expect(() => new NodeVM.Script(PICK_HIT_TEST_SOURCE)).not.toThrow();
    expect(() => new NodeVM.Script(PICK_ELEMENT_SOURCE)).not.toThrow();
  });

  it("hit-tests through a stub document", () => {
    const run = (document: unknown, x: number, y: number): unknown =>
      new NodeVM.Script(`(${PICK_HIT_TEST_SOURCE})(${x}, ${y})`).runInNewContext({ document });
    const element = {
      tagName: "BUTTON",
      shadowRoot: null,
      childElementCount: 0,
      innerText: "Buy It Now",
      className: "buy primary",
      getAttribute: (name: string) =>
        ({ id: "buy", role: null, "aria-label": null, alt: null, title: null })[name] ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
    };
    const body = { tagName: "BODY" };
    const document = {
      documentElement: { tagName: "HTML" },
      body,
      elementFromPoint: () => element,
    };
    expect(run(document, 15, 25)).toEqual({
      tag: "button",
      role: null,
      name: "Buy It Now",
      id: "buy",
      className: "buy primary",
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });
    // Hovering the page background is a miss, not a viewport-sized box.
    expect(run({ ...document, elementFromPoint: () => body }, 5, 5)).toBeNull();
    expect(run({ ...document, elementFromPoint: () => null }, 5, 5)).toBeNull();
  });

  it("pierces shadow roots and skips zero-area hits", () => {
    const run = (document: unknown): unknown =>
      new NodeVM.Script(`(${PICK_HIT_TEST_SOURCE})(1, 1)`).runInNewContext({ document });
    const inner = {
      tagName: "SPAN",
      shadowRoot: null,
      childElementCount: 0,
      innerText: "inner",
      className: "",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 4, height: 4 }),
    };
    const host = {
      tagName: "X-WIDGET",
      shadowRoot: { elementFromPoint: () => inner },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 50, height: 50 }),
    };
    const document = {
      documentElement: { tagName: "HTML" },
      body: { tagName: "BODY" },
      elementFromPoint: () => host,
    };
    expect(run(document)).toMatchObject({ tag: "span", name: "inner" });
    const flat = {
      ...inner,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 4 }),
    };
    const flatHost = { ...host, shadowRoot: { elementFromPoint: () => flat } };
    expect(run({ ...document, elementFromPoint: () => flatHost })).toBeNull();
  });

  it("captures an element through a stub document", () => {
    const attributes = [
      { name: "id", value: "buy" },
      { name: "value", value: "secret" },
      { name: "aria-pressed", value: "false" },
    ];
    const body: Record<string, unknown> = { tagName: "BODY", nodeType: 1 };
    const element: Record<string, unknown> = {
      tagName: "BUTTON",
      nodeType: 1,
      shadowRoot: null,
      innerText: "Buy It Now",
      outerHTML: '<button id="buy">Buy It Now</button>',
      className: "buy",
      labels: [],
      attributes,
      getAttribute: (name: string) => attributes.find((attr) => attr.name === name)?.value ?? null,
      hasAttribute: (name: string) => attributes.some((attr) => attr.name === name),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
      getRootNode: () => documentStub,
      ownerDocument: null as unknown,
    };
    const documentElementStub: Record<string, unknown> = { tagName: "HTML", children: [body] };
    const documentStub: Record<string, unknown> = {
      nodeType: 9,
      documentElement: documentElementStub,
      body,
      elementFromPoint: () => element,
      getElementById: () => null,
      querySelectorAll: () => [element],
      createElement: () => ({
        setAttribute: () => {},
        remove: () => {},
      }),
      defaultView: {
        getComputedStyle: () => ({ length: 0, getPropertyValue: () => "" }),
      },
    };
    element["ownerDocument"] = documentStub;
    element["parentElement"] = body;
    body["children"] = [element];
    body["parentElement"] = documentElementStub;
    documentElementStub["parentElement"] = null;
    const result = new NodeVM.Script(`(${PICK_ELEMENT_SOURCE})(15, 25)`).runInNewContext({
      document: documentStub,
    }) as Record<string, unknown>;
    expect(result["tagName"]).toBe("button");
    expect(result["selector"]).toBe("#buy");
    expect(result["role"]).toBe("button");
    expect(result["accessibleName"]).toBe("Buy It Now");
    // `value` never leaves the page, even when the allowlist walk sees it.
    expect(result["attributes"]).toEqual({ id: "buy", "aria-pressed": "false" });
    expect(result["rect"]).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });
});

describe("describePickRequest", () => {
  it("routes each pick message", () => {
    expect(describePickRequest(true, { type: "pickHitTest", x: 1, y: 2 })).toEqual({
      ok: true,
      request: { kind: "hitTest", point: { x: 1, y: 2 } },
    });
    expect(describePickRequest(true, { type: "pickCommit", x: 1, y: 2 })).toEqual({
      ok: true,
      request: { kind: "commit", point: { x: 1, y: 2 } },
    });
    expect(
      describePickRequest(true, { type: "pickCommitRegion", x: 1, y: 2, width: 3, height: 4 }),
    ).toEqual({
      ok: true,
      request: { kind: "commitRegion", rect: { x: 1, y: 2, width: 3, height: 4 } },
    });
  });

  it("ignores non-pick input", () => {
    expect(describePickRequest(true, { type: "mouse", x: 0, y: 0 })).toEqual({
      ok: false,
      reason: "other",
    });
    expect(describePickRequest(true, null)).toEqual({ ok: false, reason: "other" });
    expect(describePickRequest(true, { type: 42 })).toEqual({ ok: false, reason: "other" });
  });

  it("forbids viewers without operate access", () => {
    expect(describePickRequest(false, { type: "pickHitTest", x: 1, y: 2 })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(describePickRequest(false, { type: "pickCommit", x: 1, y: 2 })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(
      describePickRequest(false, { type: "pickCommitRegion", x: 1, y: 2, width: 3, height: 4 }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rejects malformed pick geometry", () => {
    expect(describePickRequest(true, { type: "pickHitTest", x: Number.NaN, y: 0 })).toEqual({
      ok: false,
      reason: "invalid",
      pickType: "pickHitTest",
    });
    expect(describePickRequest(true, { type: "pickCommit", x: 0 })).toEqual({
      ok: false,
      reason: "invalid",
      pickType: "pickCommit",
    });
    expect(
      describePickRequest(true, { type: "pickCommitRegion", x: 0, y: 0, width: 0, height: 4 }),
    ).toEqual({ ok: false, reason: "invalid", pickType: "pickCommitRegion" });
  });
});

describe("createPickHitTestQueue", () => {
  it("runs the first probe immediately and spaces the rest", async () => {
    let now = 1000;
    const sleeps: Array<number> = [];
    const ran: Array<{ x: number; y: number }> = [];
    const queue = createPickHitTestQueue({
      minIntervalMs: 50,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      run: async (point) => {
        ran.push(point);
      },
    });
    queue.request({ x: 1, y: 1 });
    await flushMicrotasks();
    queue.request({ x: 2, y: 2 });
    await flushMicrotasks();
    expect(ran).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(sleeps).toEqual([50]);
    expect(now).toBe(1050);
  });

  it("coalesces bursts to the latest point", async () => {
    let now = 0;
    const ran: Array<{ x: number; y: number }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createPickHitTestQueue({
      minIntervalMs: 50,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      run: async (point) => {
        ran.push(point);
        if (ran.length === 1) await gate;
      },
    });
    queue.request({ x: 1, y: 1 });
    await flushMicrotasks();
    queue.request({ x: 2, y: 2 });
    queue.request({ x: 3, y: 3 });
    await flushMicrotasks();
    expect(ran).toEqual([{ x: 1, y: 1 }]);
    release();
    await flushMicrotasks();
    expect(ran).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
  });
});

describe("hitTestElement", () => {
  it("maps a hit to a box and label", async () => {
    const seen: Array<string> = [];
    const cdp = fakeCdp(
      () =>
        evaluateResponse({
          tag: "button",
          role: null,
          name: "Buy It Now",
          id: null,
          className: null,
          rect: { x: 10, y: 20, width: 100, height: 40 },
        }),
      seen,
    );
    expect(await hitTestElement(cdp, { x: 15, y: 25 })).toEqual({
      box: { x: 10, y: 20, width: 100, height: 40 },
      label: 'button "Buy It Now"',
    });
    expect(seen).toEqual(["Runtime.evaluate"]);
  });

  it("reports misses as nulls", async () => {
    const cdp = fakeCdp(() => evaluateResponse(null));
    expect(await hitTestElement(cdp, { x: 0, y: 0 })).toEqual({ box: null, label: null });
  });

  it("throws when the page rejects the expression", async () => {
    const cdp = fakeCdp(() => ({ exceptionDetails: { text: "boom" } }));
    await expect(hitTestElement(cdp, { x: 0, y: 0 })).rejects.toBeInstanceOf(PickCaptureError);
  });
});

describe("capturePickScreenshot", () => {
  it("clips with the visual viewport offset and reports PNG dims", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const cdp: PickCdpSession = {
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Page.getLayoutMetrics") {
          return { cssVisualViewport: { pageX: 0, pageY: 200 } };
        }
        return { data: pngBytes(248, 128) };
      },
    };
    const screenshot = await capturePickScreenshot({
      cdp,
      box: { x: 10, y: 20, width: 100, height: 40 },
      viewport: { width: 1280, height: 800 },
      padding: 12,
    });
    expect(calls[1]?.params).toMatchObject({
      format: "png",
      clip: { x: 0, y: 208, width: 124, height: 64, scale: 1 },
    });
    expect(screenshot?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // True PNG dims win over clip math (zoom scales captures).
    expect(screenshot?.width).toBe(248);
    expect(screenshot?.height).toBe(128);
    expect(screenshot?.cropRect).toEqual({ x: 0, y: 8, width: 124, height: 64 });
  });

  it("returns null when the capture fails", async () => {
    const failing: PickCdpSession = {
      send: async () => {
        throw new Error("detached");
      },
    };
    expect(
      await capturePickScreenshot({
        cdp: failing,
        box: { x: 10, y: 10, width: 10, height: 10 },
        viewport: { width: 1280, height: 800 },
      }),
    ).toBeNull();
  });
});

describe("captureElementPick", () => {
  const elementValue = {
    tagName: "button",
    selector: "button.buy",
    htmlPreview: `<button>${"x".repeat(5000)}</button>`,
    textContent: "Buy It Now",
    role: "button",
    accessibleName: "Buy It Now",
    attributes: { id: "buy" },
    domPath: "body > button:nth-of-type(1)",
    rect: { x: 10, y: 20, width: 100, height: 40 },
    styles: "color: red;",
  };

  it("builds a desktop-shaped annotation with a crop", async () => {
    const seen: Array<string> = [];
    const cdp = fakeCdp((method) => {
      if (method === "Runtime.evaluate") return evaluateResponse(elementValue);
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      return { data: pngBytes(124, 64) };
    }, seen);
    const annotation = await captureElementPick({
      cdp,
      page: fakePage(),
      point: { x: 15, y: 25 },
      ...testIds(),
    });
    expect(annotation.pageUrl).toBe("https://example.com/");
    expect(annotation.comment).toBe("");
    expect(annotation.elements.length).toBe(1);
    const target = annotation.elements[0]!;
    expect(target.rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(target.element.tagName).toBe("button");
    expect(target.element.role).toBe("button");
    expect(target.element.htmlPreview.length).toBeLessThanOrEqual(4000);
    expect(annotation.screenshot?.cropRect).toEqual({ x: 0, y: 8, width: 124, height: 64 });
    // Reads only: no input ever reaches the page while picking.
    expect(seen).toEqual(["Runtime.evaluate", "Page.getLayoutMetrics", "Page.captureScreenshot"]);
  });

  it("keeps the annotation when the crop fails", async () => {
    const cdp = fakeCdp((method) => {
      if (method === "Runtime.evaluate") return evaluateResponse(elementValue);
      throw new Error("detached");
    });
    const annotation = await captureElementPick({
      cdp,
      page: fakePage(),
      point: { x: 15, y: 25 },
      ...testIds(),
    });
    expect(annotation.elements.length).toBe(1);
    expect(annotation.screenshot).toBeNull();
  });

  it("fails helpfully on a miss", async () => {
    const cdp = fakeCdp(() => evaluateResponse(null));
    await expect(
      captureElementPick({ cdp, page: fakePage(), point: { x: 0, y: 0 }, ...testIds() }),
    ).rejects.toBeInstanceOf(PickCaptureError);
  });
});

describe("captureRegionPick", () => {
  it("builds a region annotation with an exact crop", async () => {
    const seen: Array<string> = [];
    const cdp = fakeCdp((method) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      return { data: pngBytes(200, 100) };
    }, seen);
    const annotation = await captureRegionPick({
      cdp,
      page: fakePage(),
      rect: { x: 50, y: 60, width: 200, height: 100 },
      ...testIds(),
    });
    expect(annotation.elements).toEqual([]);
    expect(annotation.regions).toEqual([
      { id: annotation.regions[0]!.id, rect: { x: 50, y: 60, width: 200, height: 100 } },
    ]);
    expect(annotation.screenshot?.cropRect).toEqual({ x: 50, y: 60, width: 200, height: 100 });
    expect(seen).toEqual(["Page.getLayoutMetrics", "Page.captureScreenshot"]);
  });

  it("rejects empty regions", async () => {
    const cdp = fakeCdp(() => ({}));
    await expect(
      captureRegionPick({
        cdp,
        page: fakePage(),
        rect: { x: 5000, y: 0, width: 10, height: 10 },
        ...testIds(),
      }),
    ).rejects.toBeInstanceOf(PickCaptureError);
  });
});

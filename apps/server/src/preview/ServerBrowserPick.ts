// Page-side code is passed as source: the server compiles without DOM types.
import type {
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationScreenshot,
} from "@t3tools/contracts";
import {
  buildPickElementAnnotation,
  buildPickHoverLabel,
  buildPickRegionAnnotation,
  buildPickedElementPayload,
  normalizePickBox,
  normalizePickPoint,
  parsePngDimensions,
  pickCropRect,
  type PickBox,
  type PickPoint,
  type PickRawElementCapture,
} from "@t3tools/shared/previewPick";

/** Advertised on the stream's `control` message while picking is supported. */
export const PICK_CAPABILITIES = { pick: true } as const;

/** Minimum gap between hover evaluations for one viewer. */
export const PICK_HOVER_MIN_INTERVAL_MS = 50;

export class PickCaptureError extends Error {}

/** Minimal surface pick operations need; satisfied by Playwright's page and CDP session. */
export interface PickCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface PickPage {
  url(): string;
  title(): Promise<string>;
  viewportSize(): { readonly width: number; readonly height: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Resolves the element at a viewport point, piercing open shadow roots and
 * descending same-origin frames (cross-origin frames resolve to the frame
 * element itself). `documentElement`/`body` count as a miss: hovering them
 * would paint the whole viewport, and committing them carries no context.
 */
const PICK_RESOLVE_SOURCE = `
const resolveAt = (px, py) => {
  let doc = document;
  let dx = 0;
  let dy = 0;
  const frameTags = [];
  for (let depth = 0; depth < 5; depth++) {
    let el = null;
    try {
      el = doc.elementFromPoint(px - dx, py - dy);
    } catch (err) {
      return null;
    }
    while (el && el.shadowRoot) {
      let inner = null;
      try {
        inner = el.shadowRoot.elementFromPoint(px - dx, py - dy);
      } catch (err) {
        break;
      }
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return null;
    const tag = String((el && el.tagName) || "");
    let frameDoc = null;
    try {
      frameDoc =
        (tag === "IFRAME" || tag === "FRAME") && el.contentDocument ? el.contentDocument : null;
    } catch (err) {
      frameDoc = null;
    }
    if (frameDoc) {
      const r = el.getBoundingClientRect();
      frameTags.push(tag.toLowerCase());
      dx += r.left + (el.clientLeft || 0);
      dy += r.top + (el.clientTop || 0);
      doc = frameDoc;
      continue;
    }
    if (el === doc.documentElement || el === doc.body) return null;
    return { element: el, doc, dx, dy, frameTags };
  }
  return null;
};
`;

/** Exported for syntax tests; the page runs it via `Runtime.evaluate`. */
export const PICK_HIT_TEST_SOURCE = `
(() => {
${PICK_RESOLVE_SOURCE}
return (x, y) => {
  const hit = resolveAt(x, y);
  if (!hit) return null;
  const r = hit.element.getBoundingClientRect();
  const rect = { x: r.left + hit.dx, y: r.top + hit.dy, width: r.width, height: r.height };
  if (!(rect.width >= 1 && rect.height >= 1)) return null;
  const get = (name) => {
    try {
      return hit.element.getAttribute ? hit.element.getAttribute(name) : null;
    } catch (err) {
      return null;
    }
  };
  // innerText forces layout over the whole subtree; skip it for big containers.
  let text = "";
  try {
    if ((hit.element.childElementCount || 0) <= 10) {
      text = String(hit.element.innerText || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 80);
    }
  } catch (err) {}
  return {
    tag: String(hit.element.tagName || "").toLowerCase(),
    role: get("role"),
    name: get("aria-label") || get("alt") || get("title") || text || null,
    id: get("id"),
    className: typeof hit.element.className === "string" ? hit.element.className : null,
    rect,
  };
};
})()
`;

/** Exported for syntax tests; the page runs it via `Runtime.evaluate`. */
export const PICK_ELEMENT_SOURCE = `
(() => {
${PICK_RESOLVE_SOURCE}
const buildSelector = (el, doc) => {
  const root = el.getRootNode ? el.getRootNode() : doc;
  if (!root || root.nodeType !== 9) return null;
  const scope = root === document ? document : root;
  const esc = (value) => {
    try {
      if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    } catch (err) {}
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\\\" + ch);
  };
  const id = el.getAttribute ? el.getAttribute("id") : null;
  if (id && /^[A-Za-z][\\w:.-]*$/.test(id)) {
    try {
      if (scope.querySelectorAll("#" + esc(id)).length === 1) return "#" + esc(id);
    } catch (err) {}
  }
  const testIds = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  for (const attr of testIds) {
    const value = el.getAttribute ? el.getAttribute(attr) : null;
    if (value && value.length > 0 && value.length <= 120) {
      const candidate = el.tagName.toLowerCase() + "[" + attr + "=\\"" + esc(value) + "\\"]";
      try {
        if (scope.querySelectorAll(candidate).length === 1) return candidate;
      } catch (err) {}
    }
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== scope.body && node !== scope.documentElement) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    const parent = node.parentElement;
    if (parent) {
      let same = 0;
      let nth = 0;
      for (const child of parent.children) {
        if (child.tagName === node.tagName) {
          same += 1;
          if (child === node) nth = same;
        }
      }
      if (same > 1) part = tag + ":nth-of-type(" + nth + ")";
    }
    parts.unshift(part);
    if (parts.join(" > ").length > 400) return null;
    node = parent;
  }
  if (!node || node === scope.documentElement) return el === scope.body ? "body" : null;
  parts.unshift("body");
  const chain = parts.join(" > ");
  try {
    return scope.querySelectorAll(chain).length === 1 ? chain : null;
  } catch (err) {
    return null;
  }
};
const buildDomPath = (el, doc, frameTags) => {
  const segments = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc.documentElement) {
    const tag = String(node.tagName || "").toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      let same = 0;
      let nth = 0;
      for (const child of parent.children) {
        if (child.tagName === node.tagName) {
          same += 1;
          if (child === node) nth = same;
        }
      }
      segments.unshift(same > 1 ? tag + ":nth-of-type(" + nth + ")" : tag);
    } else {
      segments.unshift(tag);
    }
    if (segments.join(" > ").length > 800) break;
    node = parent;
  }
  let path = segments.join(" > ");
  for (const frame of frameTags) path = frame + " >> " + path;
  return path;
};
const implicitRole = (el) => {
  const explicit = el.getAttribute ? el.getAttribute("role") : null;
  if (explicit && explicit.trim()) return explicit.trim().split(/\\s+/)[0].toLowerCase();
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "a" || tag === "area") return el.hasAttribute && el.hasAttribute("href") ? "link" : null;
  if (tag === "input") {
    const type = String((el.getAttribute && el.getAttribute("type")) || "text").toLowerCase();
    if (type === "button" || type === "image" || type === "submit" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "hidden") return null;
    return "textbox";
  }
  const map = {
    article: "article", aside: "complementary", button: "button", datalist: "listbox",
    details: "group", dialog: "dialog", dd: "definition", dfn: "term", dt: "term",
    fieldset: "group", figure: "figure", footer: "contentinfo", form: "form",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    header: "banner", hr: "separator", img: "img", li: "listitem", main: "main", math: "math",
    nav: "navigation", ol: "list", optgroup: "group", option: "option", output: "status",
    progress: "progressbar", section: "region", summary: "button", table: "table",
    tbody: "rowgroup", thead: "rowgroup", tfoot: "rowgroup", td: "cell", th: "columnheader",
    tr: "row", textarea: "textbox", ul: "list",
  };
  if (tag === "select") return el.hasAttribute && el.hasAttribute("multiple") ? "listbox" : "combobox";
  return map[tag] || null;
};
const accessibleName = (el, doc) => {
  const labelledby = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
  if (labelledby) {
    const texts = [];
    for (const id of labelledby.trim().split(/\\s+/)) {
      if (!id) continue;
      const ref = doc.getElementById ? doc.getElementById(id) : null;
      if (ref && ref !== el) texts.push(String(ref.innerText || ref.textContent || "").trim());
    }
    const joined = texts.join(" ").replace(/\\s+/g, " ").trim();
    if (joined) return joined.slice(0, 300);
  }
  const labelled = el.getAttribute ? el.getAttribute("aria-label") : null;
  if (labelled && labelled.trim()) return labelled.trim().slice(0, 300);
  if (el.labels && el.labels.length > 0) {
    const labelText = String(el.labels[0].innerText || "").replace(/\\s+/g, " ").trim();
    if (labelText) return labelText.slice(0, 300);
  }
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "img" || tag === "area" || (tag === "input" && el.type === "image")) {
    const alt = el.getAttribute ? el.getAttribute("alt") : null;
    if (alt && alt.trim()) return alt.trim().slice(0, 300);
  }
  if (tag === "input" && (el.type === "button" || el.type === "submit" || el.type === "reset")) {
    const value = String(el.value || "");
    if (value.trim()) return value.trim().slice(0, 300);
  }
  const title = el.getAttribute ? el.getAttribute("title") : null;
  if (title && title.trim()) return title.trim().slice(0, 300);
  try {
    const text = String(el.innerText || "").replace(/\\s+/g, " ").trim();
    if (text) return text.slice(0, 300);
  } catch (err) {}
  return null;
};
const collectAttributes = (el) => {
  const out = {};
  if (!el.attributes) return out;
  const exact = {
    id: 1, class: 1, href: 1, src: 1, alt: 1, title: 1, role: 1, type: 1, name: 1,
    for: 1, target: 1, placeholder: 1, download: 1, rel: 1,
    "data-testid": 1, "data-test-id": 1, "data-test": 1, "data-cy": 1, "data-qa": 1,
  };
  for (const attr of el.attributes) {
    const name = String(attr.name || "").toLowerCase();
    if (name === "value" || name.length === 0) continue;
    if (!exact[name] && name.indexOf("aria-") !== 0) continue;
    if (out[name] !== undefined) continue;
    out[name] = String(attr.value).slice(0, 1000);
    if (Object.keys(out).length >= 24) break;
  }
  return out;
};
const captureStyles = (el) => {
  try {
    const parent = el.parentElement;
    if (!parent) return "";
    const owner = el.ownerDocument || document;
    const baseline = owner.createElement(String(el.tagName || "div").toLowerCase());
    baseline.setAttribute("style", "display:none !important;");
    parent.appendChild(baseline);
    let out = "";
    try {
      const computed = owner.defaultView
        ? owner.defaultView.getComputedStyle(el)
        : window.getComputedStyle(el);
      const base = owner.defaultView
        ? owner.defaultView.getComputedStyle(baseline)
        : window.getComputedStyle(baseline);
      const lines = [];
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        const value = computed.getPropertyValue(prop);
        if (!value) continue;
        if (value === base.getPropertyValue(prop)) continue;
        lines.push(prop + ": " + value + ";");
        if (lines.length >= 80) break;
      }
      out = lines.join("\\n");
    } finally {
      baseline.remove();
    }
    const className = typeof el.className === "string" ? el.className.trim().replace(/\\s+/g, " ") : "";
    if (className) out = "className: " + className.slice(0, 300) + (out ? "\\n\\n" + out : "");
    return out.slice(0, 6000);
  } catch (err) {
    return "";
  }
};
return (x, y) => {
  const hit = resolveAt(x, y);
  if (!hit) return null;
  const el = hit.element;
  const r = el.getBoundingClientRect();
  const rect = { x: r.left + hit.dx, y: r.top + hit.dy, width: r.width, height: r.height };
  if (!(rect.width >= 1 && rect.height >= 1)) return null;
  let htmlPreview = "";
  try {
    htmlPreview = String(el.outerHTML || "").slice(0, 6000);
  } catch (err) {}
  let textContent = "";
  try {
    textContent = String(el.innerText || "").slice(0, 3000);
  } catch (err) {}
  return {
    tagName: String(el.tagName || "").toLowerCase(),
    selector: buildSelector(el, hit.doc),
    htmlPreview,
    textContent,
    role: implicitRole(el),
    accessibleName: accessibleName(el, hit.doc),
    attributes: collectAttributes(el),
    domPath: buildDomPath(el, hit.doc, hit.frameTags),
    rect,
    styles: captureStyles(el),
  };
};
})()
`;

/** Runs one pick expression; coordinates are pre-validated finite numbers. */
const evaluatePickExpression = async (
  cdp: PickCdpSession,
  source: string,
  args: ReadonlyArray<number>,
): Promise<unknown> => {
  const expression = `${source}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (!isRecord(response)) throw new PickCaptureError("The page did not answer.");
  if (response["exceptionDetails"] !== undefined && response["exceptionDetails"] !== null) {
    throw new PickCaptureError("The page rejected the pick expression.");
  }
  const result = response["result"];
  if (!isRecord(result) || !("value" in result)) {
    throw new PickCaptureError("The page did not answer.");
  }
  return result["value"];
};

export interface PickHover {
  readonly box: PickBox | null;
  readonly label: string | null;
}

/** Lightweight hover probe: box plus label parts, or nulls on a miss. */
export const hitTestElement = async (cdp: PickCdpSession, point: PickPoint): Promise<PickHover> => {
  const value = await evaluatePickExpression(cdp, PICK_HIT_TEST_SOURCE, [point.x, point.y]);
  if (!isRecord(value)) return { box: null, label: null };
  const box = normalizePickBox(value["rect"]);
  if (!box || box.width < 1 || box.height < 1) return { box: null, label: null };
  const label = buildPickHoverLabel({
    tagName: asStringOrNull(value["tag"]) ?? "",
    role: asStringOrNull(value["role"]),
    accessibleName: asStringOrNull(value["name"]),
    id: asStringOrNull(value["id"]),
    className: asStringOrNull(value["className"]),
  });
  return { box, label };
};

const FALLBACK_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * PNG crop of a viewport-relative box. Clips use document offsets, so the
 * visual viewport's scroll position is added back. Null when the box is
 * unusable or the capture fails; the annotation still stands without it.
 */
export const capturePickScreenshot = async (input: {
  readonly cdp: PickCdpSession;
  readonly box: PickBox;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly padding?: number;
}): Promise<PreviewAnnotationScreenshot | null> => {
  const clip: PreviewAnnotationRect | null = pickCropRect(input.box, input.viewport, input.padding);
  if (!clip) return null;
  try {
    const metrics = await input.cdp.send("Page.getLayoutMetrics");
    const visual = isRecord(metrics) ? metrics["cssVisualViewport"] : null;
    const pageX =
      isRecord(visual) && typeof visual["pageX"] === "number" && Number.isFinite(visual["pageX"])
        ? visual["pageX"]
        : 0;
    const pageY =
      isRecord(visual) && typeof visual["pageY"] === "number" && Number.isFinite(visual["pageY"])
        ? visual["pageY"]
        : 0;
    const capture = await input.cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x: clip.x + pageX,
        y: clip.y + pageY,
        width: clip.width,
        height: clip.height,
        scale: 1,
      },
    });
    const data = isRecord(capture) ? capture["data"] : null;
    if (typeof data !== "string" || data.length === 0) return null;
    const dimensions = parsePngDimensions(data);
    return {
      dataUrl: `data:image/png;base64,${data}`,
      width: dimensions?.width ?? clip.width,
      height: dimensions?.height ?? clip.height,
      cropRect: clip,
    };
  } catch {
    return null;
  }
};

export interface PickCaptureBase {
  readonly cdp: PickCdpSession;
  readonly page: PickPage;
  readonly newId: () => string;
  readonly nowIso: () => string;
}

export interface PickCaptureInput extends PickCaptureBase {
  readonly point: PickPoint;
}

/** Full element commit: structured payload plus crop, desktop-pick shaped. */
export const captureElementPick = async (
  input: PickCaptureInput,
): Promise<PreviewAnnotationPayload> => {
  const value = await evaluatePickExpression(input.cdp, PICK_ELEMENT_SOURCE, [
    input.point.x,
    input.point.y,
  ]);
  if (!isRecord(value)) {
    throw new PickCaptureError("No element at that point. Pick an element or draw a region.");
  }
  const box = normalizePickBox(value["rect"]);
  if (!box || box.width < 1 || box.height < 1) {
    throw new PickCaptureError("No element at that point. Pick an element or draw a region.");
  }
  const pageUrl = input.page.url();
  const pageTitle = await input.page.title().catch(() => "");
  const pickedAt = input.nowIso();
  const raw: PickRawElementCapture = {
    tagName: value["tagName"],
    selector: value["selector"],
    htmlPreview: value["htmlPreview"],
    textContent: value["textContent"],
    role: value["role"],
    accessibleName: value["accessibleName"],
    attributes: value["attributes"],
    domPath: value["domPath"],
    rect: value["rect"],
    styles: value["styles"],
  };
  const element = buildPickedElementPayload(raw, {
    pageUrl,
    pageTitle: pageTitle.length > 0 ? pageTitle : null,
    pickedAt,
  });
  if (!element) {
    throw new PickCaptureError("No element at that point. Pick an element or draw a region.");
  }
  const viewport = input.page.viewportSize() ?? FALLBACK_VIEWPORT;
  const screenshot = await capturePickScreenshot({ cdp: input.cdp, box, viewport });
  return buildPickElementAnnotation(
    {
      id: input.newId(),
      pageUrl: element.pageUrl,
      pageTitle: element.pageTitle,
      createdAt: pickedAt,
      screenshot,
    },
    {
      id: input.newId(),
      element,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    },
  );
};

/** Region commit: a crop and no element. */
export const captureRegionPick = async (
  input: PickCaptureBase & { readonly rect: PickBox },
): Promise<PreviewAnnotationPayload> => {
  const viewport = input.page.viewportSize() ?? FALLBACK_VIEWPORT;
  const x = Math.max(0, Math.floor(Math.min(input.rect.x, input.rect.x + input.rect.width)));
  const y = Math.max(0, Math.floor(Math.min(input.rect.y, input.rect.y + input.rect.height)));
  const width = Math.min(Math.ceil(Math.abs(input.rect.width)), Math.floor(viewport.width) - x);
  const height = Math.min(Math.ceil(Math.abs(input.rect.height)), Math.floor(viewport.height) - y);
  if (width < 1 || height < 1) {
    throw new PickCaptureError("That region is empty. Draw a region over the page.");
  }
  const rect: PreviewAnnotationRect = { x, y, width, height };
  const pageUrl = input.page.url();
  const pageTitle = await input.page.title().catch(() => "");
  const createdAt = input.nowIso();
  const screenshot = await capturePickScreenshot({
    cdp: input.cdp,
    box: rect,
    viewport,
    padding: 0,
  });
  return buildPickRegionAnnotation(
    {
      id: input.newId(),
      pageUrl,
      pageTitle: pageTitle.length > 0 ? pageTitle : null,
      createdAt,
      screenshot,
    },
    { id: input.newId(), rect },
  );
};

export type PickRequest =
  | { readonly kind: "hitTest"; readonly point: PickPoint }
  | { readonly kind: "commit"; readonly point: PickPoint }
  | { readonly kind: "commitRegion"; readonly rect: PickBox };

export type PickRoute =
  | { readonly ok: true; readonly request: PickRequest }
  | { readonly ok: false; readonly reason: "other" | "forbidden" }
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly pickType: "pickHitTest" | "pickCommit" | "pickCommitRegion";
    };

/**
 * Pure permission gate plus message decoding for pick input. Only a viewer
 * allowed to operate may pick; picking never needs (or takes) control, so
 * this runs before the ownership check.
 */
export const describePickRequest = (canOperate: boolean, message: unknown): PickRoute => {
  if (!isRecord(message) || typeof message["type"] !== "string") {
    return { ok: false, reason: "other" };
  }
  const type = message["type"];
  if (type !== "pickHitTest" && type !== "pickCommit" && type !== "pickCommitRegion") {
    return { ok: false, reason: "other" };
  }
  if (!canOperate) return { ok: false, reason: "forbidden" };
  switch (type) {
    case "pickCommitRegion": {
      const rect = normalizePickBox(message);
      if (!rect || rect.width < 1 || rect.height < 1) {
        return { ok: false, reason: "invalid", pickType: type };
      }
      return { ok: true, request: { kind: "commitRegion", rect } };
    }
    case "pickHitTest":
    case "pickCommit": {
      const point = normalizePickPoint(message);
      if (!point) return { ok: false, reason: "invalid", pickType: type };
      return {
        ok: true,
        request: type === "pickHitTest" ? { kind: "hitTest", point } : { kind: "commit", point },
      };
    }
  }
};

export interface PickHitTestQueue {
  /** Latest-wins: an in-flight probe lets a newer point supersede it. */
  readonly request: (point: PickPoint) => void;
}

/**
 * Throttles hover probes to one per interval and coalesces bursts to the
 * latest point, so a fast pointer cannot stack evaluations on the page.
 */
export const createPickHitTestQueue = (options: {
  readonly minIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly run: (point: PickPoint) => Promise<void>;
}): PickHitTestQueue => {
  let latest: PickPoint | null = null;
  let running = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  const pump = (): void => {
    if (running) return;
    const next = latest;
    latest = null;
    if (!next) return;
    running = true;
    const wait = Math.max(0, options.minIntervalMs - (options.now() - lastStart));
    void (wait > 0 ? options.sleep(wait) : Promise.resolve())
      .then(() => {
        lastStart = options.now();
        return options.run(next);
      })
      // `run` reports its own failures; the pump must stay alive regardless.
      .catch(() => {})
      .finally(() => {
        running = false;
        pump();
      });
  };
  return {
    request: (point) => {
      latest = point;
      pump();
    },
  };
};

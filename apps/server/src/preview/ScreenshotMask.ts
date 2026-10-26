// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * Blacks out credentials in a page before a model-facing screenshot or
 * recording frame, then puts the page back. Text redaction cannot reach
 * pixels, so a revealed password or a client secret shown in a dialog would
 * otherwise reach the model as an image.
 *
 * The page lists candidate text and fields; the server classifies them with
 * PreviewRedactor's patterns, so images and text share one definition of a
 * secret. When any frame cannot be masked, callers withhold the image.
 */
import * as NodeCrypto from "node:crypto";
import type { Frame, Page } from "playwright-core";
import { containsSecret } from "./PreviewRedactor.ts";

/** Set on fields vault_fill typed into, so they stay masked after "show password". */
export const VAULT_FILLED_ATTRIBUTE = "data-cogenly-vault-filled";

export const MASK_WITHHELD_NOTE =
  "The image was withheld because credentials on this page could not be masked (for example inside a cross-origin frame). Use vault_capture to save a credential, and the snapshot's text for everything else.";

/** Larger pages are withheld rather than half-scanned. */
const MAX_SCANNED_CHARS = 4_000_000;
const FRAME_TIMEOUT_MS = 3_000;

const knownCredentials = new WeakMap<Page, Set<string>>();

/**
 * Remembers a password or vault value seen in this page, in server memory
 * only, so it stays masked and redacted after the page reveals it as text.
 */
export const rememberCredential = (page: Page, value: string) => {
  if (!value) return;
  const values = knownCredentials.get(page) ?? new Set<string>();
  values.add(value);
  knownCredentials.set(page, values);
};

export const credentialsFor = (page: Page): string[] => [...(knownCredentials.get(page) ?? [])];

export type FrameMaskCommand =
  | { readonly op: "collect"; readonly key: string; readonly maxChars: number }
  | { readonly op: "apply"; readonly key: string; readonly indices: ReadonlyArray<number> }
  | { readonly op: "restore"; readonly key: string };

export type FrameMaskResult =
  | {
      readonly texts: ReadonlyArray<string>;
      readonly flagged: ReadonlyArray<boolean>;
      readonly frames: number;
    }
  | { readonly overflow: true }
  | { readonly masked: boolean; readonly added: number }
  | { readonly restored: true };

/**
 * Runs inside each frame, so it must stay self-contained. Masks with inline
 * `!important` styles, which win over page CSS, reach shadow roots and the
 * top layer, and restore to the exact prior `style` attribute.
 */
export const frameMask = (command: FrameMaskCommand): FrameMaskResult => {
  // Mirrors VAULT_FILLED_ATTRIBUTE; this function runs in the page.
  const vaultAttribute = "data-cogenly-vault-filled";
  // The server has no DOM lib; these are the parts of the DOM this uses.
  interface Element {
    readonly nodeType: 1;
    readonly tagName: string;
    readonly isConnected: boolean;
    readonly shadowRoot: Node | null;
    readonly value?: unknown;
    readonly style: { setProperty(name: string, value: string, priority: string): void };
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
  }
  type Node =
    | Element
    | {
        readonly nodeType: 3;
        readonly nodeValue: string | null;
        readonly parentElement: Element | null;
      }
    | { readonly nodeType: 9 | 11 };
  interface State {
    elements: Element[];
    readonly masked: Map<Element, string | null>;
  }
  const host = globalThis as unknown as Record<string, State | undefined> & {
    readonly document: Node & {
      createTreeWalker(root: Node, whatToShow: number): { nextNode(): Node | null };
    };
    getComputedStyle(element: Element): { readonly filter: string };
  };
  let state = host[command.key];
  if (command.op === "restore") {
    for (const [element, style] of state?.masked ?? []) {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }
    delete host[command.key];
    return { restored: true };
  }
  if (!state) {
    state = { elements: [], masked: new Map() };
    host[command.key] = state;
  }
  if (command.op === "collect") {
    const current = state;
    const texts: string[] = [];
    const flagged: boolean[] = [];
    let chars = 0;
    let frames = 0;
    current.elements = [];
    const credentialAutocomplete =
      /(?:^|\s)(?:current-password|new-password|one-time-code|cc-(?:number|csc|exp(?:-month|-year)?))(?:\s|$)/i;
    const visit = (root: Node) => {
      // NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      const walker = host.document.createTreeWalker(root, 0x1 | 0x4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 3) {
          const parent = node.parentElement;
          const text = node.nodeValue ?? "";
          if (!parent || text.trim().length < 4) continue;
          if (/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
          current.elements.push(parent);
          texts.push(text);
          flagged.push(false);
          chars += text.length;
          continue;
        }
        if (node.nodeType !== 1) continue;
        const element = node;
        if (element.tagName === "IFRAME" || element.tagName === "FRAME") frames += 1;
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") continue;
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        if (type === "hidden") continue;
        const value = String(element.value ?? "");
        const flag =
          type === "password" ||
          element.hasAttribute(vaultAttribute) ||
          credentialAutocomplete.test(element.getAttribute("autocomplete") ?? "");
        if (!flag && value.trim().length < 4) continue;
        current.elements.push(element);
        texts.push(flag ? "" : value);
        flagged.push(flag);
        chars += value.length;
      }
    };
    visit(host.document);
    return chars > command.maxChars ? { overflow: true } : { texts, flagged, frames };
  }
  let added = 0;
  let masked = true;
  for (const index of new Set(command.indices)) {
    const element = state.elements[index];
    if (!element?.isConnected) continue;
    const wasMasked = host.getComputedStyle(element).filter === "brightness(0)";
    if (!state.masked.has(element)) state.masked.set(element, element.getAttribute("style"));
    // A page can rewrite styles between frames; re-asserting repairs that.
    element.style.setProperty("filter", "brightness(0)", "important");
    element.style.setProperty("transition", "none", "important");
    element.style.setProperty("animation", "none", "important");
    if (!wasMasked) added += 1;
    if (host.getComputedStyle(element).filter !== "brightness(0)") masked = false;
  }
  return { masked, added };
};

const withTimeout = <A>(promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Frame masking timed out.")), FRAME_TIMEOUT_MS),
    ),
  ]);

export interface MaskRefresh {
  /** Every frame was scanned and every credential in it is masked. */
  readonly confirmed: boolean;
  /** Elements masked by this refresh; a frame rendered before it may show them. */
  readonly added: number;
}

export interface PageMask {
  readonly refresh: () => Promise<MaskRefresh>;
  readonly restore: () => Promise<void>;
}

/** Credential masks for one capture or one recording. `secrets` adds known values to the patterns. */
export const maskPage = (page: Page, secrets: () => Promise<ReadonlyArray<string>>): PageMask => {
  const key = `__cogenlyMask_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const touched = new Set<Frame>();
  const classified = new Map<string, boolean>();
  let classifiedFor = "";
  const evaluate = (frame: Frame, command: FrameMaskCommand) => {
    touched.add(frame);
    // Passed by source, so `frameMask` cannot close over module values.
    return withTimeout(frame.evaluate(frameMask, command));
  };
  const maskFrame = async (frame: Frame, known: ReadonlyArray<string>) => {
    const collected = await evaluate(frame, { op: "collect", key, maxChars: MAX_SCANNED_CHARS });
    if (!("texts" in collected)) return { confirmed: false, added: 0 };
    // An iframe element Playwright has no frame for cannot be scanned.
    const confirmedFrames = collected.frames <= frame.childFrames().length;
    const indices = collected.texts.flatMap((text, index) => {
      if (collected.flagged[index]) return [index];
      let secret = classified.get(text);
      if (secret === undefined) {
        secret = containsSecret(text, known);
        classified.set(text, secret);
      }
      return secret ? [index] : [];
    });
    const applied = indices.length
      ? await evaluate(frame, { op: "apply", key, indices })
      : { masked: true, added: 0 };
    if (!("masked" in applied)) return { confirmed: false, added: 0 };
    return { confirmed: confirmedFrames && applied.masked, added: applied.added };
  };
  return {
    refresh: async () => {
      const known = (await secrets()).filter((value) => value.length > 0);
      // New known values can turn earlier text into a secret.
      const knownKey = known.toSorted().join("\u0000");
      if (knownKey !== classifiedFor) {
        classified.clear();
        classifiedFor = knownKey;
      }
      const results = await Promise.all(
        page
          .frames()
          .map((frame) => maskFrame(frame, known).catch(() => ({ confirmed: false, added: 0 }))),
      );
      return {
        confirmed: results.length > 0 && results.every((result) => result.confirmed),
        added: results.reduce((sum, result) => sum + result.added, 0),
      };
    },
    restore: async () => {
      await Promise.all(
        [...touched].map((frame) =>
          frame.isDetached()
            ? undefined
            : evaluate(frame, { op: "restore", key }).catch(() => undefined),
        ),
      );
      touched.clear();
    },
  };
};

/** Masks, captures, and restores. Returns null instead of an image that could not be masked. */
export const withMaskedPage = async <A>(
  page: Page,
  secrets: () => Promise<ReadonlyArray<string>>,
  capture: () => Promise<A>,
): Promise<A | null> => {
  const mask = maskPage(page, secrets);
  try {
    const { confirmed } = await mask.refresh();
    return confirmed ? await capture() : null;
  } finally {
    await mask.restore();
  }
};

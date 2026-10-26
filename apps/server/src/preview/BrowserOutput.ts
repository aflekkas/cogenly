import type {
  PreviewAutomationCompactElement,
  PreviewAutomationObservation,
} from "@cogenly/contracts";
import { parse } from "yaml";

const structural = new Set([
  "generic",
  "group",
  "list",
  "listitem",
  "table",
  "rowgroup",
  "row",
  "cell",
  "grid",
  "gridcell",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "toolbar",
  "menubar",
  "tablist",
]);
const MAX_ELEMENTS = 150;
const MAX_BYTES = 12_000;

/** Flatten Playwright's semantic tree, keeping actionable refs and visible content without boxes. */
export const compactElements = (tree: string, viewport?: { width: number; height: number }) => {
  const elements: PreviewAutomationCompactElement[] = [];
  let omitted = 0;
  let bytes = 0;
  const add = (element: PreviewAutomationCompactElement) => {
    const size = Buffer.byteLength(JSON.stringify(element));
    if (elements.length >= MAX_ELEMENTS || bytes + size > MAX_BYTES) {
      omitted++;
      return;
    }
    bytes += size;
    elements.push(element);
  };
  const visit = (node: unknown, visible = true) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, visible);
      return;
    }
    if (typeof node === "string") {
      entry(node, undefined, visible);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) entry(key, value, visible);
  };
  const entry = (key: string, value: unknown, inherited: boolean) => {
    if (key.startsWith("/")) return;
    const box = /\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(key);
    const visible = !viewport
      ? true
      : box
        ? Number(box[3]) > 0 &&
          Number(box[4]) > 0 &&
          Number(box[1]) < viewport.width &&
          Number(box[2]) < viewport.height &&
          Number(box[1]) + Number(box[3]) > 0 &&
          Number(box[2]) + Number(box[4]) > 0
        : inherited;
    const match = /^(\w+)(?:\s+("(?:[^"\\]|\\.)*"))?/.exec(key);
    if (!match) return;
    const role = match[1]!;
    const name = match[2] ? String(JSON.parse(match[2])) : "";
    const ref = /\[ref=([^\]]+)\]/.exec(key)?.[1];
    const states = [
      ...key.matchAll(
        /\[(checked(?:=mixed)?|disabled|expanded|active|selected|pressed(?:=mixed)?|level=\d+)\]/g,
      ),
    ].map((m) => m[1]!);
    const content =
      typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    if (visible && (!structural.has(role) || key.includes("[cursor=pointer]"))) {
      if (role !== "text" || content)
        add({
          ...(ref ? { ref } : {}),
          role,
          name: role === "text" ? (content ?? name) : name,
          ...(content && role !== "text" ? { value: content } : {}),
          ...(states.length ? { states } : {}),
        });
    }
    // Overflowing descendants may be visible even if their parent is outside the viewport.
    if (typeof value === "object") visit(value, visible);
  };
  visit(parse(tree));
  return { elements, ...(omitted ? { omitted } : {}) };
};

const keyed = (elements: ReadonlyArray<PreviewAutomationCompactElement>) => {
  const counts = new Map<string, number>();
  return new Map(
    elements.map((element) => {
      const base = element.ref ?? `${element.role}:${element.name}`;
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      return [element.ref ?? `${base}:${count}`, element] as const;
    }),
  );
};

/** Compare bounded observations by stable ref; missing baselines explicitly return the current view. */
export const observationChanges = (
  before: PreviewAutomationObservation | undefined,
  after: PreviewAutomationObservation,
): PreviewAutomationObservation => {
  if (!before) return after;
  const previous = keyed(before.elements ?? []);
  const current = keyed(after.elements ?? []);
  const changes = {
    ...(before.url !== after.url ? { url: after.url } : {}),
    ...(before.title !== after.title ? { title: after.title } : {}),
    ...(before.loading !== after.loading ? { loading: after.loading } : {}),
    changes: {
      added: [...current].filter(([key]) => !previous.has(key)).map(([, element]) => element),
      changed: [...current]
        .filter(
          ([key, element]) =>
            previous.has(key) && JSON.stringify(previous.get(key)) !== JSON.stringify(element),
        )
        .map(([, element]) => element),
      removed: [...previous.keys()].filter((key) => !current.has(key)),
    },
    ...(JSON.stringify(before.errors) !== JSON.stringify(after.errors)
      ? { errors: after.errors ?? [] }
      : {}),
    ...(after.omitted ? { omitted: after.omitted } : {}),
    ...(after.guidance ? { guidance: after.guidance } : {}),
  };
  // A viewport move can remove and add most elements: repeating their refs costs more than a reset.
  return Buffer.byteLength(JSON.stringify(changes)) >
    Buffer.byteLength(JSON.stringify(after)) + 1024
    ? { ...after, reset: true }
    : changes;
};

/** Keep inspection optional and prevent a failed read from turning a completed action into a retry. */
export const actionOutput = async <A>(input: {
  mode: "none" | "changes" | "compact" | "full";
  before?: PreviewAutomationObservation | undefined;
  action: () => Promise<A>;
  read: () => Promise<PreviewAutomationObservation>;
  dialog: () => { type: string; message: string } | undefined;
}) => {
  const before = input.before;
  const result = await input.action();
  if (input.mode === "none") return result;
  const base = typeof result === "object" && result !== null ? result : {};
  const dialog = input.dialog();
  if (dialog) return { ...base, dialog };
  try {
    const after = await input.read();
    return {
      ...base,
      observation: input.mode === "changes" ? observationChanges(before, after) : after,
    };
  } catch {
    return {
      ...base,
      observation: {
        observationError:
          "Action completed; page inspection failed. Use preview_wait_for or preview_snapshot.",
      },
    };
  }
};

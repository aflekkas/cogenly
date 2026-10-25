import type { VisualState } from "@cogenly/contracts";
import {
  type HtmlRenderVisualSnapshot,
  htmlRenderVisualError,
  readHtmlRenderVisualStateGet,
  readHtmlRenderVisualStateSet,
  readHtmlRenderVisualSubmit,
} from "@cogenly/shared/htmlRender";

/** A request a framed render made through `window.cogenly`. */
export type VisualBridgeRequest =
  | { readonly kind: "get"; readonly id: string | number }
  | {
      readonly kind: "set";
      readonly id: string | number;
      readonly state: unknown;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "submit";
      readonly id: string | number;
      readonly payload: unknown;
      readonly lock: boolean;
    };

/** The bridge request in a frame's message, if it is one. */
export function readVisualBridgeRequest(data: unknown): VisualBridgeRequest | undefined {
  const get = readHtmlRenderVisualStateGet(data);
  if (get !== undefined) return { kind: "get", id: get.id };
  const set = readHtmlRenderVisualStateSet(data);
  if (set !== undefined) return { kind: "set", ...set };
  const submit = readHtmlRenderVisualSubmit(data);
  if (submit !== undefined) return { kind: "submit", ...submit };
  return undefined;
}

/** What a page sees of a render's stored document; version 0 before its first write. */
export function visualSnapshot(
  stored: Pick<VisualState, "state" | "version" | "locked"> | null,
): HtmlRenderVisualSnapshot {
  return stored === null
    ? { state: null, version: 0, locked: false }
    : { state: stored.state ?? null, version: stored.version, locked: stored.locked };
}

/**
 * Whether `next` is news to a frame that last saw `seen`: a newer version, or
 * the same version newly locked. Projection updates that trail the frame's own
 * round-trip are dropped, so a page hears each change once.
 */
export function isVisualSnapshotNews(
  seen: Pick<HtmlRenderVisualSnapshot, "version" | "locked"> | null,
  next: Pick<HtmlRenderVisualSnapshot, "version" | "locked">,
) {
  return (
    seen === null ||
    next.version > seen.version ||
    (next.version === seen.version && next.locked && !seen.locked)
  );
}

/**
 * The error reply for a failed bridge request. A `VisualStateError` the page
 * can act on keeps its reason, and a conflict or lock carries the version that
 * won as `currentVersion`; anything else (authorization, transport) is
 * `unavailable`.
 */
export function visualBridgeErrorReply(id: string | number, failure: unknown) {
  const error = typeof failure === "object" && failure !== null ? failure : {};
  const { _tag, reason, actualVersion, message } = error as Record<string, unknown>;
  const text =
    typeof message === "string" && message !== "" ? message : "The visual request failed.";
  if (
    _tag === "VisualStateError" &&
    (reason === "version_conflict" || reason === "locked" || reason === "too_large")
  ) {
    return htmlRenderVisualError(
      id,
      reason,
      text,
      typeof actualVersion === "number" ? { currentVersion: actualVersion } : undefined,
    );
  }
  return htmlRenderVisualError(id, "unavailable", text);
}

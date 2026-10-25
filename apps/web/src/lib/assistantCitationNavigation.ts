import type { AssistantCitation } from "@cogenly/contracts";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@cogenly/shared/assistantCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { randomUUID } from "./utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantCitationActivation?: string;
  }
}

const CITATION_HASH_PREFIX = "assistant-citation=";

/** Base64url keeps router hash normalization from decoding quote whitespace or source IDs. */
export function assistantCitationHash(citation: AssistantCitation) {
  return `${CITATION_HASH_PREFIX}${Base64Url.encode(formatAssistantCitationHref(citation))}`;
}

/** Cheap pre-check for `assistantCitationFromLocation`, fit for a per-navigation selector. */
export function hasAssistantCitationHash(href: string): boolean {
  const hashIndex = href.indexOf("#");
  return hashIndex !== -1 && href.startsWith(CITATION_HASH_PREFIX, hashIndex + 1);
}

export function assistantCitationFromLocation(href: string) {
  if (!hasAssistantCitationHash(href)) return null;
  const hash = href.slice(href.indexOf("#") + 1);
  if (hash.length > 140_000) return null;
  try {
    return parseAssistantCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(CITATION_HASH_PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function assistantCitationNavigation(citation: AssistantCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    resetScroll: false,
    state: { assistantCitationActivation: randomUUID() },
  };
}

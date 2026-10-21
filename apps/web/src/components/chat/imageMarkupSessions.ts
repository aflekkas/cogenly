import { create } from "zustand";

import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore";
import type { MarkupShape } from "./imageMarkup";

/**
 * A marked-up composer image's way back: the attachment it replaced and the
 * shapes drawn on it, so the editor reopens on the original with every stroke
 * still editable, and "Revert to original" can restore it. Keyed by the
 * marked-up attachment's id. In memory only: the original's bytes do not
 * survive a reload, and a session ends once its image leaves every draft
 * (sent or removed).
 */
export interface ImageMarkupSession {
  readonly original: ComposerImageAttachment;
  readonly shapes: ReadonlyArray<MarkupShape>;
}

interface ImageMarkupSessionStore {
  readonly sessionsByImageId: Readonly<Record<string, ImageMarkupSession>>;
}

export const useImageMarkupSessionStore = create<ImageMarkupSessionStore>(() => ({
  sessionsByImageId: {},
}));

let unsubscribeDrafts: (() => void) | null = null;

function draftImageIds(): Set<string> {
  const ids = new Set<string>();
  for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadKey)) {
    for (const image of draft.images) ids.add(image.id);
  }
  return ids;
}

/** Ends sessions whose image is no longer in any draft, freeing the original's preview. */
function pruneSessions() {
  const sessions = useImageMarkupSessionStore.getState().sessionsByImageId;
  const live = draftImageIds();
  const stale = Object.keys(sessions).filter((id) => !live.has(id));
  if (stale.length === 0) return;
  const next = { ...sessions };
  for (const id of stale) delete next[id];
  const kept = new Set(Object.values(next).map((session) => session.original.previewUrl));
  for (const id of stale) {
    const original = sessions[id]?.original;
    if (
      original?.previewUrl.startsWith("blob:") &&
      !live.has(original.id) &&
      !kept.has(original.previewUrl)
    ) {
      URL.revokeObjectURL(original.previewUrl);
    }
  }
  useImageMarkupSessionStore.setState({ sessionsByImageId: next });
  if (Object.keys(next).length === 0) {
    unsubscribeDrafts?.();
    unsubscribeDrafts = null;
  }
}

export function setImageMarkupSession(imageId: string, session: ImageMarkupSession) {
  useImageMarkupSessionStore.setState((state) => ({
    sessionsByImageId: { ...state.sessionsByImageId, [imageId]: session },
  }));
  unsubscribeDrafts ??= useComposerDraftStore.subscribe(pruneSessions);
}

/** Removes a session without touching its original, which the caller has taken back. */
export function endImageMarkupSession(imageId: string) {
  useImageMarkupSessionStore.setState((state) => {
    if (!(imageId in state.sessionsByImageId)) return state;
    const next = { ...state.sessionsByImageId };
    delete next[imageId];
    return { sessionsByImageId: next };
  });
}

export const readImageMarkupSession = (imageId: string): ImageMarkupSession | undefined =>
  useImageMarkupSessionStore.getState().sessionsByImageId[imageId];

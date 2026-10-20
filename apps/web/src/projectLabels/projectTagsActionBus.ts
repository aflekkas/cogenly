const THREAD_PROJECT_TAGS_OPEN_EVENT = "cogenly:thread-project-tags-open";

/** Opens the open thread's project picker, for the command palette. */
export function requestThreadProjectTagsOpen(): void {
  window.dispatchEvent(new Event(THREAD_PROJECT_TAGS_OPEN_EVENT));
}

export function subscribeThreadProjectTagsOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_PROJECT_TAGS_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_PROJECT_TAGS_OPEN_EVENT, listener);
}

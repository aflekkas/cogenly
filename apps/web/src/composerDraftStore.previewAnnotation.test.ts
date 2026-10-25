import { EnvironmentId, ThreadId, type PreviewAnnotationPayload } from "@cogenly/contracts";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { pickMarkers } from "./browser/serverBrowserPick";
import { useComposerDraftStore } from "./composerDraftStore";
import { buildMessageContext, previewAnnotationContextId } from "./lib/composerContextRecords";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);
const pageUrl = "https://en.wikipedia.org/wiki/Main_Page";

const pick = (id: string, comment: string): PreviewAnnotationPayload => ({
  id,
  pageUrl,
  pageTitle: "Wikipedia",
  comment,
  elements: [
    {
      id: `${id}-element`,
      rect: { x: 10, y: 20, width: 200, height: 30 },
      element: {
        pageUrl,
        pageTitle: "Wikipedia",
        tagName: "span",
        selector: null,
        htmlPreview: "<span>From today's featured article</span>",
        componentName: null,
        source: null,
        stack: [],
        styles: "",
        pickedAt: "2026-10-21T00:00:00.000Z",
        role: null,
        accessibleName: "From today's featured article",
      },
    },
  ],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-10-21T00:00:00.000Z",
});

const draft = () => useComposerDraftStore.getState().getComposerDraft(threadRef);
const referenceCount = (id: string) =>
  draft()?.prompt.split(previewAnnotationContextId(id)).length! - 1;
const records = () =>
  buildMessageContext({
    terminalContexts: [],
    reviewComments: [],
    previewAnnotations: draft()?.previewAnnotations ?? [],
  })?.records.filter((record) => record.kind === "preview-annotation") ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("adding a picked annotation to the composer", () => {
  it("makes one chip and one context record per Add", () => {
    useComposerDraftStore.getState().addPreviewAnnotation(threadRef, pick("a", "Less shouty"));
    expect(draft()?.previewAnnotations).toHaveLength(1);
    expect(referenceCount("a")).toBe(1);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ comment: "Less shouty" });
  });

  it("does not duplicate when the same pick is delivered twice", () => {
    const store = useComposerDraftStore.getState();
    store.addPreviewAnnotation(threadRef, pick("a", "Less shouty"));
    store.addPreviewAnnotation(threadRef, pick("a", "Less shouty"));
    expect(draft()?.previewAnnotations).toHaveLength(1);
    expect(referenceCount("a")).toBe(1);
    expect(records()).toHaveLength(1);
  });

  it("keeps two separate picks with the same comment as two chips", () => {
    const store = useComposerDraftStore.getState();
    store.addPreviewAnnotation(threadRef, pick("a", "Less shouty"));
    store.addPreviewAnnotation(threadRef, pick("b", "Less shouty"));
    expect(records()).toHaveLength(2);
    expect(pickMarkers(draft()?.previewAnnotations ?? [], pageUrl).map((m) => m.number)).toEqual([
      1, 2,
    ]);
  });

  it("removing a chip removes its record and its marker", () => {
    const store = useComposerDraftStore.getState();
    store.addPreviewAnnotation(threadRef, pick("a", "Less shouty"));
    store.addPreviewAnnotation(threadRef, pick("b", "Crop tighter"));
    store.removePreviewAnnotation(threadRef, "a");
    expect(referenceCount("a")).toBe(0);
    expect(records()).toHaveLength(1);
    expect(pickMarkers(draft()?.previewAnnotations ?? [], pageUrl)).toEqual([
      expect.objectContaining({ id: "b", number: 1 }),
    ]);
  });
});

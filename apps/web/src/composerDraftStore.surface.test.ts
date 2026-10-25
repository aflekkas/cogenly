import { EnvironmentId, ProjectId, ThreadId } from "@cogenly/contracts";
import { scopeProjectRef } from "@cogenly/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, surfaceDraftKey, useComposerDraftStore } from "./composerDraftStore";

const mac = EnvironmentId.make("environment-mac");
// The no-project home: chats and Work without a repository both start here.
const home = scopeProjectRef(mac, ProjectId.make("project-scratch"));
const homeKey = "environment-mac:project-scratch";
const store = () => useComposerDraftStore.getState();

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

describe("a project's chat draft and Work draft", () => {
  it("are tracked apart, each with its own thread", () => {
    const chat = DraftId.make("draft-chat");
    const work = DraftId.make("draft-work");
    store().setLogicalProjectDraftThreadId(surfaceDraftKey(homeKey, "chat"), home, chat, {
      threadId: ThreadId.make("thread-chat"),
      surface: "chat",
    });
    store().setLogicalProjectDraftThreadId(surfaceDraftKey(homeKey, "work"), home, work, {
      threadId: ThreadId.make("thread-work"),
      surface: "work",
    });

    // Opening the Work draft did not take over (or retire) the empty chat draft.
    expect(
      store().getDraftSessionByLogicalProjectKey(surfaceDraftKey(homeKey, "chat")),
    ).toMatchObject({ draftId: chat, threadId: "thread-chat", surface: "chat" });
    expect(
      store().getDraftSessionByLogicalProjectKey(surfaceDraftKey(homeKey, "work")),
    ).toMatchObject({ draftId: work, threadId: "thread-work", surface: "work" });

    // Moving the Work draft to a repository leaves the chat draft where it is.
    const repository = scopeProjectRef(mac, ProjectId.make("project-site"));
    store().setLogicalProjectDraftThreadId(
      surfaceDraftKey("logical-site", "work"),
      repository,
      work,
    );
    expect(store().getDraftSession(chat)).toMatchObject({ projectId: "project-scratch" });
    expect(store().getDraftSession(work)).toMatchObject({ projectId: "project-site" });
  });

  it("keep Work on the key drafts were tracked under before surfaces split", () => {
    expect(surfaceDraftKey(homeKey, "work")).toBe(homeKey);
    expect(surfaceDraftKey(homeKey, "chat")).not.toBe(homeKey);
  });
});

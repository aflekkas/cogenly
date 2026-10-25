import { EnvironmentId, ProjectId } from "@cogenly/contracts";
import { scopeProjectRef } from "@cogenly/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");
const draftId = DraftId.make("draft-1");
const store = () => useComposerDraftStore.getState();
const pick = () => store().getDraftSession(draftId)?.launchMachine ?? null;

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  store().setProjectDraftThreadId(scopeProjectRef(mac, ProjectId.make("project-app")), draftId);
});

describe("a draft's machine pick", () => {
  it("survives picking another project and clears only when the user picks again", () => {
    store().setDraftThreadContext(draftId, { launchMachine: vps, environmentSelection: "manual" });
    expect(pick()).toBe(vps);

    store().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(mac, ProjectId.make("project-docs")),
    });
    store().setLogicalProjectDraftThreadId(
      "logical-site",
      scopeProjectRef(mac, ProjectId.make("project-site")),
      draftId,
    );
    expect(pick()).toBe(vps);

    store().setDraftThreadContext(draftId, { launchMachine: null });
    expect(pick()).toBeNull();
  });
});

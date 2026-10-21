import { type EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  beginPendingProjectFolderLaunch,
  pendingProjectFolderStep,
  readPendingProjectFolderId,
  setPendingProjectFolder,
  usePendingProjectFolderStore,
} from "./pendingProjectFolders";

const env = "env" as EnvironmentId;
const threadId = ThreadId.make("thread:draft");
const spawn = ProjectLabelId.make("label:spawn");
const bartr = ProjectLabelId.make("label:bartr");

beforeEach(() => {
  usePendingProjectFolderStore.setState({ byThreadId: {} });
});

describe("a draft's project pick at first send", () => {
  it("hands the pick to the launch, then spends it once the chat exists", () => {
    setPendingProjectFolder(threadId, { environmentId: env, folderId: spawn });
    expect(readPendingProjectFolderId(threadId, env)).toBe(spawn);
    expect(readPendingProjectFolderId(threadId, "other" as EnvironmentId)).toBeNull();

    const settle = beginPendingProjectFolderLaunch(threadId);
    const launching = usePendingProjectFolderStore.getState().byThreadId[threadId]!;
    expect(launching.launching).toBe(true);
    // While the launch runs, the coordinator leaves it alone.
    expect(pendingProjectFolderStep(launching, { folderId: null, hasTurns: false })).toBe("wait");

    settle(true);
    expect(usePendingProjectFolderStore.getState().byThreadId[threadId]).toBeUndefined();
  });

  it("keeps the pick for the restored draft when the send fails", () => {
    setPendingProjectFolder(threadId, { environmentId: env, folderId: spawn });
    beginPendingProjectFolderLaunch(threadId)(false);
    expect(usePendingProjectFolderStore.getState().byThreadId[threadId]).toEqual({
      environmentId: env,
      folderId: spawn,
    });
  });
});

describe("pendingProjectFolderStep", () => {
  const pending = { environmentId: env, folderId: spawn };

  it("waits for the thread to exist", () => {
    expect(pendingProjectFolderStep(pending, null)).toBe("wait");
  });

  it("files a thread that exists turnless outside the project", () => {
    expect(pendingProjectFolderStep(pending, { folderId: null, hasTurns: false })).toBe("move");
    expect(pendingProjectFolderStep(pending, { folderId: bartr, hasTurns: false })).toBe("move");
  });

  it("never moves a chat with turns, and drops a pick that already landed", () => {
    expect(pendingProjectFolderStep(pending, { folderId: null, hasTurns: true })).toBe("clear");
    expect(
      pendingProjectFolderStep({ ...pending, launching: true }, { folderId: null, hasTurns: true }),
    ).toBe("clear");
    expect(pendingProjectFolderStep(pending, { folderId: spawn, hasTurns: false })).toBe("clear");
  });
});

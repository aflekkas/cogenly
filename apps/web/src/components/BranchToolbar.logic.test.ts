import { describe, expect, it } from "vite-plus/test";

import { shouldShowComposerContextStrip } from "./BranchToolbar.logic";

const activeThread = {
  isDraftHeroState: false,
  persistInActiveThreads: false,
  hasActiveProject: true,
  isGitRepo: true,
  showEnvironmentIndicator: true,
  showProject: false,
  runsOnOtherMachine: false,
  hostsRestingComposerControls: true,
};

describe("shouldShowComposerContextStrip", () => {
  it("hides the strip in an active thread unless it is pinned", () => {
    expect(shouldShowComposerContextStrip(activeThread)).toBe(false);
    expect(shouldShowComposerContextStrip({ ...activeThread, persistInActiveThreads: true })).toBe(
      true,
    );
  });

  it("keeps the strip for a thread another machine runs, where it names that machine", () => {
    expect(shouldShowComposerContextStrip({ ...activeThread, runsOnOtherMachine: true })).toBe(
      true,
    );
  });

  it("still needs a project and something to show", () => {
    expect(
      shouldShowComposerContextStrip({
        ...activeThread,
        runsOnOtherMachine: true,
        hasActiveProject: false,
      }),
    ).toBe(false);
    expect(
      shouldShowComposerContextStrip({
        ...activeThread,
        runsOnOtherMachine: true,
        isGitRepo: false,
        showEnvironmentIndicator: false,
        hostsRestingComposerControls: false,
      }),
    ).toBe(false);
  });

  it("shows a new chat's project even with one machine and no Git", () => {
    expect(
      shouldShowComposerContextStrip({
        ...activeThread,
        isDraftHeroState: true,
        isGitRepo: false,
        showEnvironmentIndicator: false,
        showProject: true,
        hostsRestingComposerControls: false,
      }),
    ).toBe(true);
  });
});

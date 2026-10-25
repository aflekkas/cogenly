import { getProviderSendBlockReason } from "./ChatView.logic";
import {
  agentControlledBrowserCloseConfirmation,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveThreadDriverKind,
  resolveDraftHeroState,
  resolveEmptyServerThreadHero,
  resolveWorktreeSetupProgress,
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  scheduleEnvironmentReconnectWarning,
  codexArtifactTemplatePromptToAppend,
  shouldDockDraftHeroForSubmission,
  shouldRefocusComposerOnWindowFocus,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  resolveDraftPromotionNavigationTarget,
  resolveEffectiveInteractionMode,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
  resolveServerThreadError,
  waitForRevertedMessage,
} from "./ChatView.logic";
import { findRecordedWorktreeSetup, resolveVisibleWorktreeSetup } from "./ChatView.logic";
import {
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  threadShellHasStarted,
} from "./ChatView.logic";
import { ProviderDriverKind, type ServerProvider } from "@cogenly/contracts";
import { deriveProviderInstanceEntries } from "../providerInstances";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@cogenly/contracts";
import type { CodexArtifactTemplate } from "@cogenly/shared/codexArtifactTemplates";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";

import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("resolveDraftPromotionNavigationTarget", () => {
  const serverThreadRef = { environmentId, threadId };
  const preparingRun = {
    ...completedTurn,
    status: "preparing" as const,
    startedAt: null,
    completedAt: null,
  };

  it("stays on the draft until the server owns the send", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: preparingRun }),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread(),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
  });

  it("promotes a persisted send while its worktree is still preparing", () => {
    const serverThread = makeThread({ latestRun: preparingRun, latestUserMessageAt: now });
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });

  it("navigates once the run starts or startup stops", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestRun: { ...preparingRun, status: "failed" as const },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
  });

  it("defers while a background submission is pending", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveInteractionMode", () => {
  it("forces build mode when legacy plan mode is disabled", () => {
    expect(
      resolveEffectiveInteractionMode({
        planModeEnabled: false,
        composerInteractionMode: "plan",
        threadInteractionMode: "plan",
      }),
    ).toBe("default");
  });

  it("uses the saved mode while legacy plan mode is enabled", () => {
    expect(
      resolveEffectiveInteractionMode({
        planModeEnabled: true,
        composerInteractionMode: null,
        threadInteractionMode: "plan",
      }),
    ).toBe("plan");
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "[Terminal 1](cogenly-context://v1/terminal/ctx-expired)",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo [Terminal 1](cogenly-context://v1/terminal/ctx-expired) waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("resolveServerThreadError", () => {
  const cancelReason = "cancelled during model step";

  it("treats a user stop as a stop, not an error", () => {
    for (const latestRunStatus of ["interrupted", "cancelled"] as const) {
      expect(
        resolveServerThreadError({
          localError: null,
          sessionError: cancelReason,
          latestRunStatus,
          sessionStatus: "ready",
        }),
      ).toBeNull();
    }
  });

  it("still reports a session that broke while stopping", () => {
    expect(
      resolveServerThreadError({
        localError: null,
        sessionError: "Muse session closed",
        latestRunStatus: "interrupted",
        sessionStatus: "error",
      }),
    ).toBe("Muse session closed");
  });

  it("reports real failures and local request errors", () => {
    expect(
      resolveServerThreadError({
        localError: null,
        sessionError: "API Error: 500",
        latestRunStatus: "failed",
        sessionStatus: "ready",
      }),
    ).toBe("API Error: 500");
    expect(
      resolveServerThreadError({
        localError: "Could not send",
        sessionError: cancelReason,
        latestRunStatus: "interrupted",
        sessionStatus: "ready",
      }),
    ).toBe("Could not send");
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not release a new send when an older terminal projection arrives late", () => {
    const newer = {
      ...completedTurn,
      runId: RunId.make("newer-turn"),
      requestedAt: "2026-03-29T00:01:00.000Z",
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: newer, runtime: readySession }),
    );
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestRun: completedTurn,
        runtime: { ...readySession, status: "starting", activeRunId: newer.runId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });
  it.each(["completed", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "releases optimistic activity when a newer turn is %s before stale connecting state catches up",
    (status) => {
      const localDispatch = createLocalDispatchSnapshot(
        makeThread({ latestRun: completedTurn, runtime: readySession }),
      );
      const ended = {
        ...completedTurn,
        runId: RunId.make("turn-ended-without-output"),
        status,
        startedAt: null,
        completedAt: "2026-03-29T00:01:30.000Z",
      };
      expect(
        hasServerAcknowledgedLocalDispatch({
          localDispatch,
          phase: "connecting",
          latestRun: ended,
          runtime: { ...readySession, status: "starting", activeRunId: ended.runId },
          hasPendingApproval: false,
          hasPendingUserInput: false,
          threadError: null,
        }),
      ).toBe(true);
    },
  );
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: completedTurn,
        runtime: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer background turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { submissionIntent: "background" },
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("holds a first send while the thread shell still reports a preparing run", () => {
    // The draft had no run. The server thread's shell shows the new run before
    // the detail projection behind `phase` loads.
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const preparingRun = {
      ...completedTurn,
      status: "preparing" as const,
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: preparingRun,
        runtime: { ...readySession, status: "preparing", activeRunId: preparingRun.runId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("holds a first send while the thread shell runs ahead of the detail projection", () => {
    // The shell already reports the new run as running; `phase` still reads
    // the unloaded detail. The turn is working, so the send must stay held.
    const localDispatch = createLocalDispatchSnapshot(makeThread());

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: null,
        runtime: { ...readySession, status: "running", activeRunId: RunId.make("turn-2") },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: runningRun, runtime: runningRuntime }),
      { latestUserMessageId: MessageId.make("message-before-steer") },
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestRun: null,
      runtime: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];

    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});

describe("agent browser close confirmation", () => {
  const surfaces = [
    { id: "browser:one", kind: "preview", resourceId: "tab-1" },
    { id: "browser:two", kind: "preview", resourceId: "tab-2" },
    { id: "device", kind: "device" },
  ] satisfies RightPanelSurface[];

  it("only warns for browsers under active agent control", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "none" },
        "tab-2": { controller: "human" },
      }),
    ).toBeNull();

    expect(
      agentControlledBrowserCloseConfirmation([surfaces[0]!], {
        "tab-1": { controller: "agent" },
      }),
    ).toBe(
      [
        "Close browser while the agent is using it?",
        "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
      ].join("\n"),
    );
  });

  it("counts every agent-controlled browser in a bulk close", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "agent" },
        "tab-2": { controller: "agent" },
      }),
    ).toContain("Close 2 browsers");
  });
});

describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about…";

    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("leaves the hero layout while a worktree setup card is on the timeline", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: true,
        hasTimelineEntries: false,
        isWorking: false,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: false,
        hasWorktreeSetupCard: true,
      }),
    ).toBe(false);
    // A background submission normally pins the hero, but never over the card.
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: true,
        hasTimelineEntries: false,
        isWorking: false,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
        hasWorktreeSetupCard: true,
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  describe("resolveEmptyServerThreadHero", () => {
    const emptyShell = {
      latestRun: null,
      itemCount: 0,
      latestUserMessageAt: null,
      settledOverride: null,
      snoozedUntil: null,
      source: {},
    };
    const emptyThread = {
      isServerThread: true,
      hasOwnEmptyState: false,
      hasTimelineEntries: false,
      isWorking: false,
      hasHistoryToLoad: false,
      hasWorktreeSetupCard: false,
      draftHeroDockRequested: false,
      shell: emptyShell,
    };

    it("opens a thread nobody has written in like a new one", () => {
      expect(resolveEmptyServerThreadHero(emptyThread)).toBe(true);
    });

    it("docks once a message is on its way, and for any thread with history", () => {
      expect(resolveEmptyServerThreadHero({ ...emptyThread, draftHeroDockRequested: true })).toBe(
        false,
      );
      expect(resolveEmptyServerThreadHero({ ...emptyThread, hasTimelineEntries: true })).toBe(
        false,
      );
      expect(resolveEmptyServerThreadHero({ ...emptyThread, isWorking: true })).toBe(false);
      // Rows still loading: the shell already counts them.
      expect(
        resolveEmptyServerThreadHero({ ...emptyThread, shell: { ...emptyShell, itemCount: 3 } }),
      ).toBe(false);
      expect(
        resolveEmptyServerThreadHero({
          ...emptyThread,
          shell: { ...emptyShell, latestRun: { id: "run-1" } },
        }),
      ).toBe(false);
    });

    it("keeps the timeline where its footer has a line to show", () => {
      expect(
        resolveEmptyServerThreadHero({
          ...emptyThread,
          shell: { ...emptyShell, settledOverride: "settled" },
        }),
      ).toBe(false);
      expect(
        resolveEmptyServerThreadHero({
          ...emptyThread,
          shell: { ...emptyShell, snoozedUntil: "2026-10-23T09:00:00.000Z" },
        }),
      ).toBe(false);
      expect(
        resolveEmptyServerThreadHero({
          ...emptyThread,
          shell: { ...emptyShell, source: { workHandoffs: [{}] } },
        }),
      ).toBe(false);
    });

    it("leaves drafts, agent conversations and embedded views to their own screens", () => {
      expect(resolveEmptyServerThreadHero({ ...emptyThread, isServerThread: false })).toBe(false);
      expect(resolveEmptyServerThreadHero({ ...emptyThread, hasOwnEmptyState: true })).toBe(false);
    });
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("never paints the previous thread's entries while the next thread is loading", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-b",
        nextEntries: [],
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-b" });
  });

  it("shows the new thread once its detail is ready", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["b1"],
      }),
    ).toEqual({ entries: ["b1"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not invent a timeline on the first open of a thread", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("keeps the held thread workspace cwd with the snapshot", () => {
    rememberReadyThreadTimeline({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
    expect(peekHeldThreadTimeline<string[]>()).toEqual({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
  });

  it("survives a ChatView remount by remembering the last ready timeline", () => {
    rememberReadyThreadTimeline(held);
    expect(peekHeldThreadTimeline<string[]>()).toEqual(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["b1", "b2"] });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("prefers live entries over a remembered snapshot", () => {
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["stale-b"] });
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["fresh-b"],
      }),
    ).toEqual({ entries: ["fresh-b"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not keep a remembered snapshot on a resolved empty thread", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("treats a foreign held timeline as paint-only", () => {
    expect(isPaintOnlyThreadTimeline("env-1:thread-a", "env-1:thread-b")).toBe(true);
    expect(isPaintOnlyThreadTimeline("env-1:thread-b", "env-1:thread-b")).toBe(false);
  });

  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

describe("resolveComposerProviderSelection", () => {
  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["muse", "muse_work"],
    ["ollama", "local_models"],
  ])("keeps imported %s history selectable through its custom instance", (driver, instanceId) => {
    const importedEntry = entry(driver, instanceId);
    const entries = [entry(driver === "codex" ? "claudeAgent" : "codex"), importedEntry];
    const thread = importedThread(importedEntry.instanceId);
    const lockedProvider = deriveLockedProvider({
      thread,
      selectedProvider: entries[0]!.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers: entries.map((entry) => entry.snapshot),
    });

    expect(thread.runtime).toBeNull();
    expect(lockedProvider).toBe(driver);
    expect(
      resolveComposerProviderSelection({
        entries,
        candidateInstanceIds: [thread.modelSelection.instanceId],
        lockedProvider,
        lockedInstanceId: thread.modelSelection.instanceId,
      }).selectedProviderEntry?.instanceId,
    ).toBe(importedEntry.instanceId);
  });

  it("keeps the session driver authoritative over instance and draft selections", () => {
    const selected = entry("claudeAgent", "claude_work");
    const sessionEntry = entry("ollama", "local_models");
    const thread = importedThread(selected.instanceId);

    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          runtime: {
            ...readySession,
            providerName: sessionEntry.driverKind,
            providerInstanceId: sessionEntry.instanceId,
          },
        },
        selectedProvider: selected.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: [selected.snapshot, sessionEntry.snapshot],
      }),
    ).toBe(sessionEntry.driverKind);
  });

  it.each(["missing", "disabled"] as const)(
    "does not move imported history to another driver when its instance is %s",
    (state) => {
      const imported = entry("claudeAgent", "claude_work", { enabled: false });
      const other = entry("codex");
      const entries = state === "missing" ? [other] : [other, imported];
      const thread = importedThread(imported.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: other.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });

      expect(lockedProvider).not.toBeNull();
      expect(
        resolveComposerProviderSelection({
          entries,
          candidateInstanceIds: [other.instanceId, imported.instanceId],
          lockedProvider,
          lockedInstanceId: imported.instanceId,
        }).selectedProviderEntry,
      ).toBeUndefined();
    },
  );

  it("leaves a new draft free to select a different driver", () => {
    const original = entry("claudeAgent", "claude_work");
    const selected = entry("codex", "codex_work");
    expect(
      deriveLockedProvider({
        thread: makeThread({
          modelSelection: { instanceId: original.instanceId, model: "default" },
        }),
        selectedProvider: selected.instanceId,
        threadProvider: original.instanceId,
        providers: [original.snapshot, selected.snapshot],
      }),
    ).toBeNull();
  });

  it("keeps an unlocked thread on its own driver when the instance that ran it is missing", () => {
    const codex = entry("codex");
    const claude = entry("claudeAgent");
    const missing = ProviderInstanceId.make("claude-personal");
    const select = (threadDriverKind: ProviderDriverKind | null) =>
      resolveComposerProviderSelection({
        entries: [codex, claude],
        candidateInstanceIds: [missing],
        lockedProvider: null,
        lockedInstanceId: missing,
        threadDriverKind,
      }).selectedProviderEntry?.instanceId;

    expect(select(claude.driverKind)).toBe(claude.instanceId);
    expect(select(null)).toBe(codex.instanceId);
  });
});

describe("resolveThreadDriverKind", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");

  it("reads the active provider thread's driver", () => {
    expect(
      resolveThreadDriverKind({
        thread: { activeProviderThreadId: "pt-2" },
        providerThreads: [
          { id: "pt-1", driver: codex },
          { id: "pt-2", driver: claude },
        ],
        turnItems: [],
      }),
    ).toBe(claude);
  });

  it("reads a provider subagent's driver from its native items", () => {
    expect(
      resolveThreadDriverKind({
        thread: { activeProviderThreadId: null },
        providerThreads: [],
        turnItems: [{ nativeItemRef: { driver: claude } }, { nativeItemRef: null }],
      }),
    ).toBe(claude);
  });

  it("knows nothing about a thread without detail or history", () => {
    expect(resolveThreadDriverKind(null)).toBeNull();
    expect(
      resolveThreadDriverKind({
        thread: { activeProviderThreadId: null },
        providerThreads: [],
        turnItems: [],
      }),
    ).toBeNull();
  });
});

describe("resolveComposerInteractionMode", () => {
  it("resets a restored plan draft when the selected instance does not support plan mode", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: { showInteractionModeToggle: false },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("keeps legacy plan behavior for providers that omit the capability", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: {},
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("resets a restored plan draft when the beta setting is off", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: false,
        provider: { showInteractionModeToggle: true },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("disables plan mode until the selected provider is available", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: null,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("shouldRefocusComposerOnWindowFocus", () => {
  function element(
    tagName: string,
    options?: { editable?: boolean; role?: string; within?: string },
  ) {
    return {
      tagName,
      isContentEditable: options?.editable ?? false,
      getAttribute: (name: string) => (name === "role" ? (options?.role ?? null) : null),
      closest: (selector: string) =>
        options?.within !== undefined && selector.includes(options.within) ? ({} as Element) : null,
    };
  }

  it("refocuses when nothing or the body holds focus", () => {
    expect(shouldRefocusComposerOnWindowFocus(null)).toBe(true);
    expect(shouldRefocusComposerOnWindowFocus(element("BODY"))).toBe(true);
  });

  it("refocuses away from a plain button, such as a pull request tab", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON"))).toBe(true);
  });

  it("leaves other text fields alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("INPUT"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("TEXTAREA"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { editable: true }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { role: "textbox" }))).toBe(false);
  });

  it.each(["IFRAME", "WEBVIEW"])("leaves a focused %s preview alone", (tagName) => {
    expect(shouldRefocusComposerOnWindowFocus(element(tagName))).toBe(false);
  });

  it("leaves a focused terminal alone in the drawer and the right panel", () => {
    expect(
      shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "data-terminal-owner" })),
    ).toBe(false);
  });

  it("leaves focus inside a dialog or popup alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "dialog" }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "-popup" }))).toBe(false);
  });
});

describe("checkout Git memory", () => {
  it("answers from the last status seen for the same checkout", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", false);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(false);
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", true);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(true);
  });

  it("does not answer for a checkout it has not seen", () => {
    expect(recallCheckoutIsRepo(environmentId, "/repo/never-opened")).toBeUndefined();
    expect(recallCheckoutIsRepo(environmentId, null)).toBeUndefined();
  });

  it("keeps environments apart", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/shared-path", false);
    expect(
      recallCheckoutIsRepo(EnvironmentId.make("env-other"), "/repo/shared-path"),
    ).toBeUndefined();
  });

  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});

describe("threadShellHasStarted", () => {
  it("counts a thread that has a user message but no latest turn", () => {
    expect(
      threadShellHasStarted({ latestRun: null, latestUserMessageAt: now, runtime: null }),
    ).toBe(true);
  });

  it("counts a thread with a live runtime and nothing else", () => {
    expect(
      threadShellHasStarted({
        latestRun: null,
        latestUserMessageAt: null,
        runtime: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "starting",
          providerName: "codex",
          activeRunId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    ).toBe(true);
  });

  it("does not count a thread that never sent anything", () => {
    expect(
      threadShellHasStarted({ latestRun: null, latestUserMessageAt: null, runtime: null }),
    ).toBe(false);
    expect(threadShellHasStarted(null)).toBe(false);
  });
});

describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };

  it("keeps setup presentation continuous until the provider handoff", () => {
    const progress = (
      localPreparing: boolean,
      runStatus: NonNullable<Thread["latestRun"]>["status"] | undefined,
      latest: WorktreeSetupSnapshot | null,
      held: WorktreeSetupSnapshot | null = null,
    ) => resolveWorktreeSetupProgress({ threadId, localPreparing, runStatus, latest, held });

    // The local send, its durable acknowledgement, and the stream arrive separately.
    expect(progress(true, undefined, null).isPreparingWorktree).toBe(true);
    expect(progress(false, "preparing", null).isPreparingWorktree).toBe(true);
    expect(progress(false, "preparing", base).snapshot).toBe(base);
    // Releasing the prepared run precedes the tracker marking the agent started.
    expect(progress(false, "starting", base).isPreparingWorktree).toBe(true);
    const handedOff = {
      ...base,
      sequence: 2,
      stages: [stage("setup-script", "running"), stage("agent", "done")],
    };
    expect(progress(false, "starting", handedOff, base)).toEqual({
      snapshot: handedOff,
      isPreparingWorktree: false,
    });
    expect(progress(false, "running", null, handedOff).snapshot).toBe(handedOff);
  });

  it("uses streamed setup progress immediately without reverting to an older held snapshot", () => {
    const newest = { ...settledDone, sequence: 9 };
    const resolve = (latest: WorktreeSetupSnapshot | null, held: WorktreeSetupSnapshot | null) =>
      resolveWorktreeSetupProgress({
        threadId,
        localPreparing: false,
        runStatus: "running",
        latest,
        held,
      });
    expect(resolve(newest, base)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    expect(resolve(base, newest)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    const other = { ...base, threadId: ThreadId.make("another-thread") };
    expect(resolve(other, other)).toEqual({ snapshot: null, isPreparingWorktree: false });
  });

  it.each(["failed", "cancelled"] as const)(
    "does not keep %s setup in the preparing state",
    (phase) => {
      const snapshot = { ...base, phase };
      expect(
        resolveWorktreeSetupProgress({
          threadId,
          localPreparing: false,
          runStatus: "failed",
          latest: snapshot,
          held: base,
        }),
      ).toEqual({ snapshot, isPreparingWorktree: false });
    },
  );

  it("reads the settled snapshot back from the thread's activities", () => {
    const activities = [
      { kind: "setup-script.started", payload: {} },
      { kind: "worktree-setup", payload: settledDone },
      { kind: "worktree-setup", payload: { not: "a snapshot" } },
    ];
    expect(findRecordedWorktreeSetup(activities, threadId)).toEqual(settledDone);
    expect(findRecordedWorktreeSetup(activities, ThreadId.make("other"))).toBeNull();
  });

  it("shows a running setup and drops a clean one once the turn started", () => {
    const visible = (snapshot: WorktreeSetupSnapshot | null, turnStarted: boolean) =>
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: snapshot,
        turnStarted,
        followUpSent: false,
      });
    expect(
      resolveVisibleWorktreeSetup({
        live: base,
        recorded: null,
        turnStarted: false,
        followUpSent: false,
      }),
    ).toEqual(base);
    expect(visible(settledDone, false)).toEqual(settledDone);
    expect(visible(settledDone, true)).toBeNull();
    expect(visible(null, true)).toBeNull();
  });

  it("keeps a failed script, a failed setup, and a cancelled setup visible", () => {
    const scriptFailed = {
      ...settledDone,
      stages: [stage("checkout", "done"), stage("setup-script", "failed"), stage("agent", "done")],
    };
    const visible = (snapshot: WorktreeSetupSnapshot, followUpSent = false) =>
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: snapshot,
        turnStarted: true,
        followUpSent,
      });
    expect(visible(scriptFailed)).toEqual(scriptFailed);
    const failed = { ...settledDone, phase: "failed" as const, error: "git exploded" };
    expect(visible(failed)).toEqual(failed);
    const cancelled = { ...settledDone, phase: "cancelled" as const };
    expect(visible(cancelled)).toEqual(cancelled);

    // The setup belongs to the first turn. A follow-up send retires every
    // settled outcome; only a script that is still running stays.
    expect(visible(scriptFailed, true)).toBeNull();
    expect(visible(failed, true)).toBeNull();
    expect(visible(cancelled, true)).toBeNull();
    expect(visible(settledDone, true)).toBeNull();
    const stillRunning = {
      ...base,
      stages: [stage("checkout", "done"), stage("setup-script", "running"), stage("agent", "done")],
    };
    expect(visible(stillRunning, true)).toEqual(stillRunning);
  });

  it("prefers whichever snapshot is newer by sequence", () => {
    const pick = (live: WorktreeSetupSnapshot | null, recorded: WorktreeSetupSnapshot | null) =>
      resolveVisibleWorktreeSetup({ live, recorded, turnStarted: false, followUpSent: false });
    expect(pick({ ...base, sequence: 3 }, { ...settledDone, sequence: 7 })).toEqual({
      ...settledDone,
      sequence: 7,
    });
    expect(pick({ ...settledDone, sequence: 9 }, { ...base, sequence: 1 })).toEqual({
      ...settledDone,
      sequence: 9,
    });
  });
});

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const projection = {
      ...base,
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, messageId, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it("ignores a failure recorded for an earlier rollback", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, messageId, 1, requestId, async () => {}, 50);
    const settled = expect(waiting).rejects.toThrow("Timed out waiting for the thread to rewind.");
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId: CommandId.make("rollback-0"), message: "Old failure." },
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    vi.useRealTimers();
  });
});

describe("retired provider history", () => {
  it("blocks retired providers while allowing supported accounts", () => {
    expect(
      getProviderSendBlockReason({ driver: ProviderDriverKind.make("cursor") }, "old-model"),
    ).toContain("read-only history");
    expect(
      getProviderSendBlockReason(
        { driver: ProviderDriverKind.make("claudeAgent") },
        "claude-fable-5-1",
      ),
    ).toBeNull();
    expect(
      getProviderSendBlockReason({ driver: ProviderDriverKind.make("codex") }, "gpt-6-astra"),
    ).toBeNull();
    expect(
      getProviderSendBlockReason({ driver: ProviderDriverKind.make("muse") }, "muse-spark-1.3"),
    ).toBeNull();
  });
});

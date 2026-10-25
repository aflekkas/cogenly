import { AgentConversation } from "../agents/AgentConversation";
import { useAgents, useAgentConversation } from "../agents/agentsClient";
import { scopedThreadKey } from "@cogenly/client-runtime/environment";
import type { ScopedThreadRef } from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import ChatView from "./ChatView";
import {
  peekRememberedThreadTimeline,
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import { settleModeSwitchMainPane } from "./sidebar/modes/modeSwitchMotion";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import {
  isThreadRouteContentReady,
  resolveThreadRouteHold,
  threadRouteHoldRemainingMs,
} from "../threadRouteHold";
import { threadRouteTargetKey } from "../threadRouteSlots";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveAgentConversationRemoval,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * The single chat surface behind both `/draft/$draftId` and
 * `/$environmentId/$threadId`. Each draft gets its own ChatView instance (so
 * a background send's state stays with the draft it came from), and that
 * instance carries the draft through its promotion to a server thread: the
 * thread route keeps keying by the draft id while the draft record exists,
 * so the route swap only changes props and the timeline never paints an
 * empty frame. Plain server threads are unkeyed, so navigating between them
 * reuses one instance as ChatView expects.
 *
 * Rendered by the `_chat` layout rather than by the two leaf routes, since
 * an element only survives a route swap when the same parent renders it.
 * `retained`: the route has moved on and this view only stands in, inert,
 * until the next route has content, so it must not redirect.
 *
 * Moving to a thread whose content is still loading keeps the current one on
 * screen, inert, for up to THREAD_ROUTE_HOLD_MAX_MS, so the next appears
 * complete instead of filling in (see threadRouteHold.ts).
 */
export function ThreadRouteView({
  target,
  retained = false,
}: {
  target: ThreadRouteTarget;
  retained?: boolean;
}) {
  const hold = useThreadRouteHold(target, retained);
  return <ThreadRouteContent target={hold.target} retained={retained || hold.holding} />;
}

function useThreadRouteHold(target: ThreadRouteTarget, retained: boolean) {
  const [shown, setShown] = useState<ThreadRouteTarget | null>(null);
  const [expired, setExpired] = useState(false);
  const nextRef = target.kind === "server" ? target.threadRef : null;
  // Mounting the next thread here starts its load while the current one shows;
  // the opened view reads the same state, and leaving it early cancels it.
  const nextState = useEnvironmentThread(nextRef?.environmentId ?? null, nextRef?.threadId ?? null);
  const nextShell = useThreadShell(nextRef);
  const nextReady =
    nextRef === null ||
    isThreadRouteContentReady({
      state: nextState,
      shell: nextShell,
      hasRememberedTimeline: peekRememberedThreadTimeline(scopedThreadKey(nextRef)) !== null,
    });
  const decision = resolveThreadRouteHold({ shown, next: target, nextReady, expired, retained });
  if (
    !decision.holding &&
    (shown === null || threadRouteTargetKey(shown) !== threadRouteTargetKey(decision.target))
  ) {
    setShown(decision.target);
  }
  if (!decision.holding && expired) setExpired(false);
  // One bound per hold, even when the destination changes again mid-hold.
  const holdSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!decision.holding) {
      holdSinceRef.current = null;
      return;
    }
    const since = holdSinceRef.current ?? performance.now();
    holdSinceRef.current = since;
    const timeout = window.setTimeout(
      () => setExpired(true),
      threadRouteHoldRemainingMs(since, performance.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [decision.holding]);
  return decision;
}

function ThreadRouteContent({
  target,
  retained,
}: {
  target: ThreadRouteTarget;
  retained: boolean;
}) {
  const navigate = useNavigate();
  const { agents, loading: agentsLoading, reconnecting: agentsReconnecting } = useAgents();
  const contact =
    target.kind === "server"
      ? (agents.find(
          (agent) =>
            agent.environmentId === target.threadRef.environmentId &&
            agent.conversationThreadId === target.threadRef.threadId,
        ) ?? null)
      : null;
  const agentConversation = useAgentConversation(contact);
  // Deleting an agent keeps its conversation thread, so without this the route
  // would fall back to a plain chat of it.
  const [shownAgentThreadKey, setShownAgentThreadKey] = useState<string | null>(null);
  const agentRemoval = resolveAgentConversationRemoval({
    shownAgentThreadKey,
    routeThreadKey: target.kind === "server" ? scopedThreadKey(target.threadRef) : null,
    agentPresent: contact !== null,
    agentsSettled: !agentsLoading && !agentsReconnecting,
  });
  if (agentRemoval.shownAgentThreadKey !== shownAgentThreadKey) {
    setShownAgentThreadKey(agentRemoval.shownAgentThreadKey);
  }
  const agentRemoved = agentRemoval.removed;
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // The server thread this view is about: the route's own ref, or the draft's
  // reserved ref once the server knows it.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef);
  const serverThread = useThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shell.data?.status);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef || retained) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate, retained]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef || retained) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, retained, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete || retained) {
      return;
    }
    // Navigation already resolved onto this path, so a drop aimed here
    // passed its landing check; once the thread reads as missing it can
    // never be attached, release it even when there is nowhere to redirect.
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, retained, target]);

  // The open agent left the agents list: deleted here, on another device, or
  // by an agent over MCP. Land again like a missing thread does: the index
  // opens the next agent, or the Agents empty state when none are left.
  useEffect(() => {
    if (!agentRemoved || retained) return;
    void navigate({ to: "/", replace: true });
  }, [agentRemoved, navigate, retained]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (agentRemoved) {
    // Nothing until the redirect lands, not a frame of the bare conversation.
    view = null;
  } else if (agentConversation) {
    view = (
      <AgentConversation
        key={`${agentConversation.environmentId}:${agentConversation.id}`}
        agent={agentConversation}
      />
    );
  } else if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextChatViewKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  // A hand-picked sidebar mode crossfades to the thread it lands on.
  const targetKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
  useLayoutEffect(() => {
    // Settles when the view takes another thread.
    void targetKey;
    if (!retained) settleModeSwitchMainPane();
  }, [retained, targetKey]);

  return (
    <SidebarInset
      // Clips vertically only: content gliding from where it was drawn crosses
      // the pane's new left edge while the sidebar opens (panelFlip).
      className="h-svh min-h-0 overflow-y-clip overscroll-y-none md:h-dvh"
      data-retained-thread-view={retained ? "" : undefined}
      inert={retained || undefined}
    >
      {view}
    </SidebarInset>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cogenly/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ThreadId,
  type ThreadSurface,
} from "@cogenly/contracts";
import { isScratchProject } from "@cogenly/client-runtime/state/projects";
import { useParams, useRouter } from "@tanstack/react-router";
import { create } from "zustand";
import { useCallback, useMemo } from "react";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  surfaceDraftKey,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  resolveNewThreadEnvMode,
  resolveProjectFileSettings,
} from "@cogenly/shared/projectSettings";
import {
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { readProjectConfigFile } from "../lib/projectConfigFile";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { workPrefersNewWorktree } from "../components/work/work.logic";
import { usePendingProjectFolderStore } from "../projectLabels/pendingProjectFolders";
import { useClientSettings } from "./useSettings";

/** Pending draft setup must clear the previous thread header before its async config read. */
export const useNewThreadPending = create(() => ({ count: 0 }));

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

// The workspace options the caller passed explicitly, shaped for the draft
// store: absent keys stay absent so they never overwrite existing draft
// state. Every reuse path applies exactly this set.
function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
  };
}

export function useNewThreadHandler() {
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  const openNewThread = useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        replace?: boolean;
        /**
         * Chats or Work. Defaults to the surface the user is on, so every entry point
         * (button, shortcut, palette, links) classifies the same way; Chats entry points
         * pass "chat" explicitly. A project never decides this.
         */
        surface?: ThreadSurface;
      },
      // Which draft the thread ended up in, so a caller that has something to put in it (a
      // prepared checkout, a task to write) addresses that one rather than looking the project
      // up again and finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const projects = readProjects();
      const targetServerSettings =
        environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const requestingRouteHref = router.state.location.href;
      const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's working mode from the thread being
      // viewed. The target project's configured model still wins; interaction
      // mode carries independently. Permissions, branch, worktree, and env mode
      // come from configured defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state; they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      // Picking a repository is starting Work. Only the no-repository folder is
      // ambiguous, and there the surface the user is on decides.
      const startsInScratch =
        project?.isScratch === true ||
        (project !== undefined &&
          isScratchProject(
            project,
            environmentServerConfigs.get(projectRef.environmentId)?.scratchWorkspaceRoot,
          ));
      const surface: ThreadSurface =
        options?.surface ??
        (startsInScratch && useUiStateStore.getState().sidebarMode === "chats" ? "chat" : "work");
      // Removal can land while the project file is read; a draft opened
      // after that belongs to a project that no longer exists.
      const abandonedSinceRequest = () =>
        routeChangedSinceRequest() || (project !== undefined && readProject(projectRef) === null);
      // Every new thread, chat or work, starts in full access whatever the project defaults say.
      const defaultRuntimeMode = "full-access";
      const projectDefaultModelSelection = targetServerSettings.defaultModelSelection;
      const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
        resolveNewThreadModelSelectionOverride({
          projectDefaultSelection: projectDefaultModelSelection ?? null,
          carrySelection: carryModelSelection,
          carrySourceDraftId:
            currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
          destinationDraftId,
        });
      // The shared resolver owns the priority order. The cogenly.json read is
      // skipped entirely when a higher-priority source decides, and its
      // query atom caches per project after the first call.
      const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        const consultProjectFile =
          project !== undefined && targetServerSettings.defaultThreadEnvMode === null;
        const projectFile = consultProjectFile
          ? await readProjectConfigFile(project.environmentId, project.workspaceRoot)
          : null;
        const resolvedProjectSettings = resolveProjectFileSettings(
          targetServerSettings,
          projectFile,
        );
        const preferWorktree = workPrefersNewWorktree({
          inWorkMode: useUiStateStore.getState().sidebarMode === "tasks",
          isScratch: project?.isScratch === true,
          environmentDefault: targetServerSettings.defaultThreadEnvMode,
          resolvedSource: resolvedProjectSettings.sources.defaultThreadEnvMode,
        });
        return resolveNewThreadEnvMode({
          projectSettings: preferWorktree
            ? {
                ...resolvedProjectSettings,
                settings: { ...resolvedProjectSettings.settings, defaultThreadEnvMode: "worktree" },
              }
            : resolvedProjectSettings,
          workspaceRoot: project?.workspaceRoot ?? null,
          newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
          projectHasThreads: readThreadShells().some(
            (thread) =>
              thread.environmentId === projectRef.environmentId &&
              thread.projectId === projectRef.projectId,
          ),
        });
      };
      // Each surface keeps its own draft per project: a Work draft never
      // reuses (and re-files) the chat draft of the same project.
      const logicalProjectKey = surfaceDraftKey(
        project
          ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
          : scopedProjectKey(projectRef),
        surface,
      );
      // Opening a repository's draft picks that repository, so the draft
      // follows its project: a reused draft drops the project it was left in,
      // which may not hold the repository. A caller filing it in a project
      // (the Work hero) does so once this resolves.
      const forgetLeftProject = (opened: { draftId: DraftId; threadId: ThreadId } | null) => {
        if (opened !== null && !startsInScratch) {
          usePendingProjectFolderStore.getState().clearPending(opened.threadId);
        }
        return opened;
      };
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const mappedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      // A draft tracked before surfaces split may be the other surface's: it
      // is not this surface's draft, so it is neither reused nor retired.
      const storedDraftThread =
        mappedDraftThread !== null && (mappedDraftThread.surface ?? surface) === surface
          ? mappedDraftThread
          : null;
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThread !== null &&
        storedDraftThread.promotedTo == null &&
        storedDraftThreadRef !== null &&
        readThreadShell(storedDraftThreadRef) === null
          ? storedDraftThread
          : null;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only
      // ever reuse a draft the user has NOT invested in. A draft with typed
      // text or attachments is work in progress: it stays alive where it is
      // (reachable from the sidebar draft rows) and this request mints a
      // fresh draft instead. The remap in the store preserves invested
      // drafts rather than deleting them.
      const emptyStoredDraftThread =
        reusableStoredDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
          ? reusableStoredDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Resurrecting an empty stored draft must not resurrect its stale
          // context: explicit workspace options win outright; otherwise the
          // env context resets to the configured defaults so drafts seeded
          // before a defaults change (or by the old carry-over behavior) stop
          // landing on "current checkout" branches forever. When the draft is
          // already open and no options were passed, leave its workspace
          // context alone entirely: the user may have just picked a branch
          // in the composer. Model selection has its own explicit-pick rule
          // below and does not follow this guard.
          let workspaceContext: NewThreadWorkspaceOptions | null = null;
          if (hasExplicitWorkspaceOption) {
            workspaceContext = pickExplicitWorkspaceOptions(options);
          } else if (!isDraftAlreadyOpen) {
            const defaultEnvMode = await resolveDefaultEnvMode();
            if (abandonedSinceRequest()) {
              return null;
            }
            // The await yields. If the draft was opened (a concurrent
            // invocation's navigation landed), promoted to a real thread,
            // remapped away (a concurrent invocation registered a fresh
            // draft; remapping back would evict the winner and let the
            // store GC it), or gained content (no longer a reusable empty
            // draft) in the meantime, this invocation is a stale loser:
            // resetting context, remapping, or navigating would all clobber
            // state written after the snapshot above. Bail out entirely;
            // the winner already did this work.
            const routeTargetNow = getCurrentRouteTarget();
            const openedMeanwhile =
              routeTargetNow?.kind === "draft" &&
              routeTargetNow.draftId === emptyStoredDraftThread.draftId;
            const promotedMeanwhile =
              storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
            const remappedMeanwhile =
              getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
              emptyStoredDraftThread.draftId;
            const investedMeanwhile = composerDraftHasUserContent(
              getComposerDraft(emptyStoredDraftThread.draftId),
            );
            if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
              return null;
            }
            workspaceContext = {
              branch: null,
              worktreePath: null,
              envMode: defaultEnvMode,
              startFromOrigin: resolveNewDraftStartFromOrigin({
                envMode: defaultEnvMode,
                newWorktreesStartFromOrigin: targetServerSettings.newWorktreesStartFromOrigin,
              }),
            };
          }
          if (workspaceContext) {
            setDraftThreadContext(emptyStoredDraftThread.draftId, {
              surface,
              ...workspaceContext,
              ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
          }
          // Model intent: an explicit human pick always stands. Seeds and
          // legacy entries alike re-resolve here: sticky first, mirroring
          // the mint-fresh path, then the project default or carried
          // selection on top. This runs even when the draft is already open:
          // without it, a changed pin could never reach the draft the user
          // is looking at, because explicit picks are the only thing the
          // flag protects.
          const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
          const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
          if (!storedDraftHasExplicitModelPick) {
            applyStickyState(emptyStoredDraftThread.draftId);
            const modelSelectionOverride = resolveModelSelectionOverride(
              emptyStoredDraftThread.draftId,
            );
            if (modelSelectionOverride) {
              // This is a complete snapshot: absent options mean "no options",
              // not "keep the stale draft's options".
              setModelSelection(emptyStoredDraftThread.draftId, modelSelectionOverride, {
                replaceOptions: true,
              });
            }
          }
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              surface,
              ...workspaceContext,
              ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          // Re-read the route: the snapshot from before the await is stale
          // once a concurrent invocation's navigation lands, and navigating
          // again would push a duplicate history entry.
          const routeTargetAfterWrites = getCurrentRouteTarget();
          if (
            routeTargetAfterWrites?.kind === "draft" &&
            routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
          ) {
            return opened;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
          return opened;
        })().then(forgetLeftProject);
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          surface,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        return Promise.resolve(
          forgetLeftProject({
            draftId: currentRouteTarget.draftId,
            threadId: latestActiveDraftThread.threadId,
          }),
        );
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
        if (abandonedSinceRequest()) {
          return null;
        }
        // The await yields, so a concurrent invocation may have registered a
        // draft for this logical project in the meantime. Registering ours
        // too would evict that draft while its navigation is in flight, so
        // reuse the winner instead, like the synchronous path above does.
        const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (
          racedDraft &&
          // Only a draft REGISTERED during the await counts as a raced
          // winner. An invested draft this invocation deliberately declined
          // to reuse is still mapped at this point; reusing it here would
          // silently undo mint-fresh semantics.
          racedDraft.draftId !== mappedDraftThread?.draftId &&
          readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
        ) {
          // Same remap the reuse paths above perform: point the draft at the
          // caller's project member and apply explicit workspace options if
          // the caller passed any. Without explicit options the winner's
          // context stands untouched: the winner's navigation is landing,
          // which is the isDraftAlreadyOpen "leave it alone" case. Writing
          // this invocation's defaults here instead would clobber the
          // winner's explicit picks and could pair its worktreePath with a
          // contradictory envMode.
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
            threadId: racedDraft.threadId,
            surface,
            createdAt: racedDraft.createdAt,
            runtimeMode: racedDraft.runtimeMode,
            interactionMode: racedDraft.interactionMode,
            ...pickExplicitWorkspaceOptions(options),
          });
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
          return forgetLeftProject({ draftId: racedDraft.draftId, threadId: racedDraft.threadId });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          surface,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: targetServerSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: defaultRuntimeMode,
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        applyStickyState(draftId);
        const modelSelectionOverride = resolveModelSelectionOverride(draftId);
        if (modelSelectionOverride) {
          // Project defaults and carried selections both outrank global sticky
          // state. The project default wins when both are present.
          setModelSelection(draftId, modelSelectionOverride, { replaceOptions: true });
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [environmentServerConfigs, getCurrentRouteTarget, projectGroupingSettings, router],
  );
  return useCallback(
    async (...args: Parameters<typeof openNewThread>) => {
      useNewThreadPending.setState((state) => ({ count: state.count + 1 }));
      try {
        return await openNewThread(...args);
      } finally {
        useNewThreadPending.setState((state) => ({ count: state.count - 1 }));
      }
    },
    [openNewThread],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}

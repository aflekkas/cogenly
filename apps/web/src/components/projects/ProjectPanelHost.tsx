import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { capturePanelFlip, playPanelFlip, type PanelFlipSnapshot } from "../../lib/panelFlip";
import { PANEL_ANIMATION_DURATION, usePanelPresence } from "../../panelAnimations";
import { projectLabelKey } from "../../projectLabels/projectLabels.logic";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useUiStateStore } from "../../uiStateStore";
import { FadeSwap } from "../chat/StateTransition";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { RightPanelSheet } from "../RightPanelSheet";
import { ProjectDetail } from "./ProjectDetail";

interface ProjectSelection {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}

const PROJECT_PANEL_WIDTH_STORAGE_KEY = "cogenly:project-panel-width";
const PROJECT_PANEL_DEFAULT_WIDTH = 400;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Slides the panel and the main pane's marked content when `open` changes,
 * in the same flip as the browser panel (panelFlip). The old layout is read
 * in the render that changes `open`, before it commits; the glide plays once
 * it has. Only reduced motion snaps: the change is the user's pick, even
 * though it arrives as a navigation.
 */
function useProjectPanelFlip(open: boolean) {
  const [flip, setFlip] = useState<{
    readonly open: boolean;
    readonly snapshot: PanelFlipSnapshot | null;
  }>({ open, snapshot: null });
  if (flip.open !== open) {
    const animates =
      typeof window !== "undefined" && !window.matchMedia(REDUCED_MOTION_QUERY).matches;
    setFlip({ open, snapshot: animates ? capturePanelFlip(document.body) : null });
  }
  useLayoutEffect(() => {
    if (flip.snapshot) playPanelFlip(flip.snapshot, PANEL_ANIMATION_DURATION, { contain: true });
  }, [flip]);
}

/**
 * The project panel on the right of the main pane, for Projects mode: the
 * picked project's detail (its chats, Work, repositories, files and sources).
 * It slides in with a pick and out when the pick clears, and crossfades in
 * place when the pick changes. Narrow windows get a sheet instead. Lives in
 * the chat layout, beside whatever the main pane shows, so the main pane
 * (the project's chat hero) needs no knowledge of it.
 */
export function ProjectPanelHost() {
  const navigate = useNavigate();
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const selection = useParams({
    strict: false,
    select: (params): ProjectSelection | null =>
      "labelId" in params && params.labelId && params.environmentId
        ? {
            environmentId: params.environmentId as EnvironmentId,
            labelId: params.labelId as ProjectLabelId,
          }
        : null,
  });
  const open = sidebarMode === "projects" && selection !== null;
  const selectionKey = selection
    ? projectLabelKey(selection.environmentId, selection.labelId)
    : null;
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // The closing panel keeps its project until it has left.
  const presence = usePanelPresence(open, selection, selectionKey, PANEL_ANIMATION_DURATION);
  useProjectPanelFlip(open && !sheet);
  const close = () => void navigate({ to: "/project" });
  const shown = presence.value;

  if (sheet) {
    return (
      <RightPanelSheet animationDurationMs={PANEL_ANIMATION_DURATION} open={open} onClose={close}>
        {shown ? (
          <ProjectDetail
            key={projectLabelKey(shown.environmentId, shown.labelId)}
            environmentId={shown.environmentId}
            labelId={shown.labelId}
            onClose={close}
          />
        ) : null}
      </RightPanelSheet>
    );
  }
  if (!presence.present || shown === null) return null;
  return (
    <PreviewPanelShell
      mode="inline"
      open={open}
      widthStorageKey={PROJECT_PANEL_WIDTH_STORAGE_KEY}
      defaultWidth={PROJECT_PANEL_DEFAULT_WIDTH}
    >
      <div className="h-full min-h-0 wco:pt-(--workspace-topbar-height)" data-project-panel>
        <FadeSwap
          group="project-panel"
          swapKey={projectLabelKey(shown.environmentId, shown.labelId)}
          className="block h-full min-h-0"
        >
          <ProjectDetail
            environmentId={shown.environmentId}
            labelId={shown.labelId}
            onClose={close}
          />
        </FadeSwap>
      </div>
    </PreviewPanelShell>
  );
}

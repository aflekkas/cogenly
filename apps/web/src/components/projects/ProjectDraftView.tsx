import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import type { DraftId } from "../../composerDraftStore";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { setPendingProjectFolder } from "../../projectLabels/pendingProjectFolders";
import { ThreadRouteView } from "../ThreadRouteView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

type DraftState = { readonly draftId: DraftId } | null;

/**
 * A picked project's main area: the new-chat hero in that project. It is the
 * ordinary chat draft of the machine's scratch folder, filed in the project
 * before it is sent, rendered here under the project's own URL instead of
 * the draft route, so the Projects list stays beside it. The draft is the
 * one New chat would open, so picking another project re-files that same
 * empty draft rather than minting one per visit.
 */
export function ProjectDraftView(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  const { environmentId, labelId } = props;
  const { openScratchProject, scratchEnvironmentId } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const [draft, setDraft] = useState<DraftState>(null);
  // The scratch folder the chat starts in, or null when this machine offers none.
  const scratch = scratchEnvironmentId(environmentId);
  // An effect event: a change of handlers never restarts the draft.
  const startDraft = useEffectEvent(
    async (
      scratchEnvironment: EnvironmentId,
      folderId: ProjectLabelId,
      isCancelled: () => boolean,
    ) => {
      const project = await openScratchProject(scratchEnvironment);
      if (isCancelled() || project === null) return null;
      const started = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        surface: "chat",
        navigate: false,
      });
      if (isCancelled() || started === null) return null;
      setPendingProjectFolder(started.threadId, {
        environmentId: project.environmentId,
        folderId,
      });
      return started.draftId;
    },
  );

  useEffect(() => {
    if (scratch === null) return;
    let cancelled = false;
    void startDraft(scratch, labelId, () => cancelled).then((draftId) => {
      if (draftId !== null && !cancelled) setDraft({ draftId });
    });
    return () => {
      cancelled = true;
    };
  }, [scratch, labelId]);

  if (draft !== null && scratch !== null) {
    return <ThreadRouteView target={{ kind: "draft", draftId: draft.draftId }} />;
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} />
        {scratch === null ? (
          <Empty size="compact" className="h-full">
            <EmptyHeader>
              <EmptyTitle>Chats aren't available here</EmptyTitle>
              <EmptyDescription>
                This machine can't start a chat without a repository right now.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </SidebarInset>
  );
}

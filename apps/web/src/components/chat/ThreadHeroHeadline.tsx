import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@cogenly/client-runtime/state/shell";
import { useMemo, useRef, useState } from "react";

import { ComposerProjectPicker } from "~/projectLabels/ComposerProjectPicker";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import {
  projectLabelKey,
  scopedRepositoryKey,
  threadProjectFolderId,
} from "~/projectLabels/projectLabels.logic";
import { workHeroBreadcrumb, workThreadDisplayProject } from "~/projectLabels/projectMeta.logic";
import { linkedRepositoryIcon } from "~/projectLabels/repositoryPicker.logic";
import { RepositoryRowIcon } from "~/projectLabels/RepositorySourceRows";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { useRepositoryNames } from "~/projectLabels/useRepositoryNames";
import { chatGreeting } from "./chatGreeting";
import { FadeSwap } from "./StateTransition";
import { useHeroHeadlineMotion } from "./useHeroHeadlineMotion";
import { WorkHeroCrumbText, WorkHeroSentence } from "./WorkHeroSentence";

/**
 * The hero headline for a thread that exists but was never written in, over
 * the centred composer, so it opens like the new-thread screen
 * (DraftHeroHeadline). Where a Work thread runs is fixed once it exists, so
 * its sentence only names the project and repository; a chat keeps the
 * greeting and its project tail, which still moves the chat.
 */
export function ThreadHeroHeadline({
  thread,
  project,
  isChat,
  isScratch,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly isChat: boolean;
  /** Work in its project's folder, without a repository. */
  readonly isScratch: boolean;
}) {
  const environmentIds = useMemo(() => [thread.environmentId], [thread.environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const folderId = threadProjectFolderId(thread);
  const filed =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  // Work names its repository's project when its filing does not hold it.
  const folder = isChat
    ? filed
    : workThreadDisplayProject({
        filed,
        repository:
          isScratch || project === null
            ? null
            : { environmentId: project.environmentId, projectId: project.id },
        folderByRepository: directory.folderByRepository,
      });
  // Fixed when the screen opens, so the line holds still while the user types.
  const [greeting] = useState(() => chatGreeting(new Date()));
  const headingRef = useRef<HTMLHeadingElement>(null);
  useHeroHeadlineMotion(headingRef, isChat ? "chat" : "work");

  // The new-Work screen's sentence, read-only: both halves always named.
  const repositoryNameOf = useRepositoryNames();
  const breadcrumb = workHeroBreadcrumb({
    projectName: folder?.label.name ?? null,
    repositoryName: project ? repositoryNameOf(project) : null,
    hasRepository: !isScratch,
  });
  const headingLabel = isChat
    ? `${greeting}${folder ? ` · in ${folder.label.name}` : ""}`
    : breadcrumb.label;

  const repository = (
    <WorkHeroCrumbText
      crumb={breadcrumb.repository}
      icon={
        project ? (
          // The same icon the repository picker's row shows for it.
          <span className="inline-flex size-[0.78em] align-[-0.06em] me-[0.28em] items-center justify-center">
            <RepositoryRowIcon
              local={project}
              {...linkedRepositoryIcon(
                directory.folderByRepository.get(
                  scopedRepositoryKey(project.environmentId, project.id),
                ) ?? null,
                project.id,
              )}
              environmentId={project.environmentId}
              // Sized in em to the heading, like the hero's other inline icons.
              className="size-full"
            />
          </span>
        ) : null
      }
    />
  );
  const projectName = (
    <WorkHeroCrumbText
      crumb={breadcrumb.project}
      icon={
        <ProjectFolderIcon
          project={folder}
          className="inline-block"
          style={HERO_INLINE_ICON_STYLE}
        />
      }
    />
  );

  return (
    <div className="@container flex w-full flex-col items-center">
      <h1
        ref={headingRef}
        style={{ fontSize: "clamp(var(--text-xl), 3cqw, var(--text-3xl))" }}
        aria-label={headingLabel}
        className="group/hero-headline relative w-full origin-bottom text-balance text-center font-normal text-xl text-foreground tracking-tight"
      >
        {/* The new-thread screen's slot, so moving between it and here cross-fades. */}
        <FadeSwap
          group="draft-heading"
          swapKey={isChat ? "chat" : `thread:${thread.environmentId}:${thread.id}`}
        >
          {isChat ? (
            <>
              <span data-hero-greeting="" className="inline">
                {greeting}
              </span>
              <ComposerProjectPicker
                appearance="hero"
                environmentId={thread.environmentId}
                threadId={thread.id}
                draftId={null}
                size="sm"
              />
            </>
          ) : (
            <WorkHeroSentence project={projectName} repository={repository} />
          )}
        </FadeSwap>
      </h1>
    </div>
  );
}

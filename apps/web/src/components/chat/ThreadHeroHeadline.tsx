import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@cogenly/client-runtime/state/shell";
import { useMemo, useRef, useState } from "react";

import { ComposerProjectPicker } from "~/projectLabels/ComposerProjectPicker";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import { projectLabelKey, threadProjectFolderId } from "~/projectLabels/projectLabels.logic";
import { workHeroBreadcrumb } from "~/projectLabels/projectMeta.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { ProjectFavicon } from "../ProjectFavicon";
import { RepositoryBadge } from "../sidebar/modes/RepositoryBadge";
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
  const folder =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  // Fixed when the screen opens, so the line holds still while the user types.
  const [greeting] = useState(() => chatGreeting(new Date()));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  useHeroHeadlineMotion(headingRef, measureRef, isChat ? `chat:${thread.id}` : "heading");

  // The new-Work screen's sentence, read-only: both halves always named.
  const breadcrumb = workHeroBreadcrumb({
    projectName: folder?.label.name ?? null,
    repositoryName: project?.title ?? null,
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
          <ProjectFavicon
            project={project}
            // Sized in em to the heading, like the hero's other inline icons.
            className="inline-block size-[0.78em] align-[-0.06em] me-[0.28em]"
            fallback={<RepositoryBadge name={project.title} size="inline" />}
          />
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
        aria-label={headingLabel}
        className="group/hero-headline relative w-full origin-bottom text-balance text-center font-normal text-xl text-foreground tracking-tight @xl:text-2xl @2xl:text-3xl"
      >
        {/* The greeting and its project on one line, to tell whether they fit. */}
        <span
          ref={measureRef}
          aria-hidden
          className="pointer-events-none invisible absolute start-0 top-0 whitespace-pre"
        />
        {/* The new-thread screen's slot, so moving between it and here cross-fades. */}
        <FadeSwap
          group="draft-heading"
          swapKey={isChat ? "chat" : `thread:${thread.environmentId}:${thread.id}`}
        >
          {isChat ? (
            <>
              <span
                data-hero-greeting=""
                className="inline-block max-w-full group-data-stacked/hero-headline:block"
              >
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

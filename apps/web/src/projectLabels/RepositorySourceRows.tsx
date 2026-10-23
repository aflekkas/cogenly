import type { ProjectLabelOwnerRepository, RepositoryIdentity } from "@t3tools/contracts";
import { FolderIcon, LockIcon, Settings2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { GitHubIcon } from "~/components/Icons";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  ComboboxCollection,
  ComboboxGroupItems,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxItemIcon,
} from "~/components/ui/combobox";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { OwnerSearchState } from "./projectSourceLinks.logic";
import { describeCloneFailure, gitHubRepositoryOf } from "./repositoryPicker.logic";
import type { RemoteCloneView, useRemoteRepositoryClone } from "./useRemoteRepositoryClone";

/*
 * The rows every repository picker shares: a project's repositories split by
 * where they live ("On this machine", "On GitHub"), and a GitHub repository's
 * row with its clone in progress under it. Used by the composer's repository
 * picker and the Start Work picker.
 */

/** Where a run of picker rows lives: on a machine, or on GitHub. */
export function RepositorySourceLabel(props: { readonly icon: ReactNode; readonly label: string }) {
  return (
    <ComboboxGroupLabel>
      <span className="flex size-4 shrink-0 items-center justify-center">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
    </ComboboxGroupLabel>
  );
}

/**
 * A project's GitHub results under its own repositories: a quiet "On GitHub"
 * line, then the repositories not on this machine yet. A slow search shows
 * one spinner row; a failed one a single muted line. Render the rows through
 * `renderItem`, typically with `RemoteRepositoryRow`.
 */
export function RemoteRepositorySection<Item>(props: {
  readonly state: OwnerSearchState;
  readonly owners: ReadonlyArray<string>;
  readonly renderItem: (item: Item) => ReactNode;
}) {
  const { state } = props;
  const ownerName =
    props.owners.length === 0
      ? "your repositories"
      : props.owners.length === 1
        ? props.owners[0]
        : "linked owners";
  return (
    <div className="reveal-motion">
      <RepositorySourceLabel
        icon={<GitHubIcon aria-hidden className="size-3" />}
        label="On GitHub"
      />
      {state.status === "loading" ? (
        <div className="reveal-motion flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Spinner size="xs" tone="muted" />
          </span>
          <span className="min-w-0 truncate">Searching {ownerName}…</span>
        </div>
      ) : state.status === "error" ? (
        <p className="reveal-motion select-text break-words py-1 ps-8 pe-2 text-xs text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      <ComboboxGroupItems afterHeader>
        <ComboboxCollection>{(item: Item) => props.renderItem(item)}</ComboboxCollection>
      </ComboboxGroupItems>
    </div>
  );
}

/**
 * A GitHub repository's row: picking it clones it into its project. While
 * this row's clone runs its icon spins and the status line under it shows
 * progress, then the failure with Retry and Dismiss.
 */
export function RemoteRepositoryRow<Item>(props: {
  readonly item: Item;
  readonly repository: ProjectLabelOwnerRepository;
  readonly clone: ReturnType<typeof useRemoteRepositoryClone>;
  /** This row's clone, when the followed clone is this repository's. */
  readonly view: RemoteCloneView | null;
}) {
  const { repository, view, clone } = props;
  const busy = view?.phase === "starting" || view?.phase === "running";
  return (
    <>
      <ComboboxItem hideIndicator value={props.item}>
        <ComboboxItemIcon>
          {busy ? (
            <Spinner size="xs" tone="muted" />
          ) : (
            <GitHubIcon aria-hidden className="size-3.5" />
          )}
        </ComboboxItemIcon>
        <TruncatedWithTooltip
          text={repository.name}
          tooltip={`Clone ${repository.nameWithOwner} into this project`}
          className="min-w-0 shrink text-sm"
        />
        {repository.private ? <LockIcon aria-label="Private" className="size-3 shrink-0" /> : null}
        {repository.description ? (
          <TruncatedWithTooltip
            text={repository.description}
            className="min-w-0 flex-1 text-xs text-muted-foreground"
          />
        ) : null}
      </ComboboxItem>
      {view ? (
        <RemoteCloneStatus
          key={view.phase}
          view={view}
          repository={repository.nameWithOwner}
          onCancel={() => void clone.cancel()}
          onRetry={() => void clone.retry()}
          onDismiss={() => void clone.dismiss()}
        />
      ) : null}
    </>
  );
}

/** One line that truncates, with the full text in a tooltip. */
function TruncatedWithTooltip(props: {
  readonly text: string;
  readonly tooltip?: string;
  readonly className: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("truncate", props.className)} />}>
        {props.text}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? props.text}</TooltipPopup>
    </Tooltip>
  );
}

/** The clone of a picked GitHub repository, under its row: progress, then the way on. */
function RemoteCloneStatus(props: {
  readonly view: RemoteCloneView;
  readonly repository: string;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const { view } = props;
  if (view.phase === "done") return null;
  if (view.phase === "failed" || view.phase === "cancelled") {
    const failure =
      view.phase === "failed" ? describeCloneFailure(view.message, props.repository) : null;
    return (
      <div
        role={failure ? "alert" : "status"}
        // Lines up with the row's name. A failure wraps in full and can be
        // selected and copied: the advice first, then git's own words.
        className="reveal-motion flex flex-col gap-1 py-1 ps-8 pe-1 text-xs"
      >
        {failure ? (
          <div className="select-text space-y-0.5 break-words">
            <p className="text-destructive-foreground">{failure.summary}</p>
            {failure.detail ? (
              <p className="whitespace-pre-wrap font-mono text-2xs text-muted-foreground">
                {failure.detail}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground">Clone cancelled. Nothing was added.</p>
        )}
        <div className="flex gap-1">
          <Button size="xs" variant="outline" onClick={props.onRetry}>
            Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="reveal-motion flex min-h-7 items-center gap-1 py-0.5 ps-8 pe-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">
        {view.phase === "starting" ? "Starting clone…" : view.summary}
      </span>
      {view.phase === "running" ? (
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The trailing marks of a project's own repository row: the GitHub
 * repository it was cloned from, and a way to take it out of the project.
 */
export function LocalRepositoryRowEnd(props: {
  readonly identity: RepositoryIdentity | null | undefined;
  /** Absent where the user cannot change the project. */
  readonly onRemove?: () => void;
  readonly removeLabel: string;
}) {
  const gitHub = gitHubRepositoryOf(props.identity);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {gitHub ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={`On GitHub as ${gitHub}`}
                className="inline-flex items-center text-muted-foreground"
              />
            }
          >
            <GitHubIcon aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{`On GitHub as ${gitHub}`}</TooltipPopup>
        </Tooltip>
      ) : null}
      {props.onRemove ? (
        // Shown on the highlighted row only. The item would pick the row on
        // click, so the button keeps its events to itself.
        <span className="flex opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard in-data-highlighted:opacity-100 motion-reduce:transition-none">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-destructive"
                  aria-label={props.removeLabel}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onRemove?.();
                  }}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">{props.removeLabel}</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </span>
  );
}

/** The "Manage repositories…" row's look, shared by every repository picker. */
export function ManageRepositoriesRowContent() {
  return (
    <>
      <ComboboxItemIcon>
        <Settings2Icon className="size-4" />
      </ComboboxItemIcon>
      <span className="min-w-0 flex-1 truncate text-sm">Manage repositories…</span>
    </>
  );
}

/** The "No repository (project folder)" row's mark: the folder itself, not the project's colour. */
export function ProjectFolderRowIcon() {
  return <FolderIcon className="size-4" />;
}

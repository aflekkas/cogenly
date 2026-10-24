import type { ProjectLabelOwnerRepository } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  HardDriveIcon,
  LockIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { GitHubIcon } from "~/components/Icons";
import { ProjectFavicon, type ProjectFaviconProject } from "~/components/ProjectFavicon";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ComboboxItem, ComboboxItemIcon } from "~/components/ui/combobox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { OwnerSearchState } from "./projectSourceLinks.logic";
import { describeCloneFailure, type RepositoryRowView } from "./repositoryPicker.logic";
import type { RemoteCloneView, useRemoteRepositoryClone } from "./useRemoteRepositoryClone";

/*
 * The pieces every repository row is built from, in the pickers (composer,
 * Start Work, "Add repository") and on the project page: the icon, the
 * state on the selected machine, the failure under the row, and the row
 * menu. `RepositoryPickerRow` puts them in a picker row; the project page
 * passes them to its card row.
 */

/**
 * A repository's icon: its own (picked in settings, else its favicon, through
 * the shared project icon resolver) when it has a checkout here, else GitHub's
 * mark for a GitHub remote, else the repository glyph.
 */
export function RepositoryRowIcon(props: {
  readonly local: ProjectFaviconProject | null;
  readonly remote: string | null;
  readonly className?: string;
}) {
  const className = props.className ?? "size-4";
  if (props.local !== null) {
    return (
      <ProjectFavicon
        project={props.local}
        className={className}
        fallback={<FolderGit2Icon className={className} />}
      />
    );
  }
  if (props.remote?.toLowerCase().startsWith("github.com/")) {
    return <GitHubIcon aria-hidden className="size-3.5" />;
  }
  return <FolderGit2Icon className={className} />;
}

/** The text a row's state reads as, for its trailing mark and accessible name. */
export function repositoryRowStatusText(view: RepositoryRowView): string | null {
  switch (view.kind) {
    case "ready":
      return null;
    case "needs-clone":
      return "Clone to set up";
    case "starting":
      return "Starting clone…";
    case "cloning":
      return view.progress ?? "Cloning…";
    case "failed":
      return "Clone failed · Retry";
  }
}

/**
 * A row's state on the selected machine, at its end: nothing once cloned,
 * "Clone to set up", the clone's own progress while it runs (a spinner only
 * while the server reports it running), or the failure. Each change fades.
 */
export function RepositoryRowStatus(props: { readonly view: RepositoryRowView }) {
  const text = repositoryRowStatusText(props.view);
  if (text === null) return null;
  const { kind } = props.view;
  return (
    <span
      key={kind}
      role={kind === "cloning" || kind === "starting" ? "status" : undefined}
      className={cn(
        "swap-motion flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 text-2xs tabular-nums",
        kind === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {kind === "cloning" ? <Spinner size="xs" tone="muted" /> : null}
      <span className="truncate">{text}</span>
    </span>
  );
}

/** A failed clone's reason under its row, in full and selectable: advice first, then git's words. */
export function RepositoryRowError(props: {
  readonly view: RepositoryRowView;
  readonly name: string;
  readonly className?: string;
}) {
  if (props.view.kind !== "failed" || props.view.message === null) return null;
  const failure = describeCloneFailure(props.view.message, props.name);
  return (
    <div
      role="alert"
      className={cn(
        "reveal-motion select-text space-y-0.5 break-words py-1 pe-2 text-xs",
        props.className ?? "ps-8",
      )}
    >
      <p className="text-destructive-foreground">{failure.summary}</p>
      {failure.detail ? (
        <p className="whitespace-pre-wrap font-mono text-2xs text-muted-foreground">
          {failure.detail}
        </p>
      ) : null}
    </div>
  );
}

export interface RepositoryRowMenuAction {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly destructive?: boolean;
  readonly onSelect: () => void;
}

/** The row menu's usual actions, in the order every surface lists them. */
export const repositoryRowMenuIcons = {
  moveIntoProjectFolder: <FolderInputIcon />,
  removeFromMachine: <HardDriveIcon />,
  removeFromProject: <XIcon />,
} as const;

/**
 * A row's ⋯ menu. Shown on the highlighted (or hovered) row only; inside a
 * picker row the trigger keeps its pointer events so the row is not picked.
 */
export function RepositoryRowMenu(props: {
  readonly label: string;
  readonly actions: ReadonlyArray<RepositoryRowMenuAction>;
}) {
  if (props.actions.length === 0) return null;
  return (
    <span
      className="flex shrink-0 opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard in-data-highlighted:opacity-100 group-hover/card-row:opacity-100 group-focus-within/card-row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Menu>
        <MenuTrigger
          render={<Button size="icon-micro" variant="ghost-muted" aria-label={props.label} />}
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {props.actions.map((action) => (
            <MenuItem
              key={action.key}
              {...(action.destructive ? { variant: "destructive" as const } : {})}
              onClick={action.onSelect}
            >
              {action.icon}
              {action.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </span>
  );
}

/**
 * One picker row: icon, the repository's name (its full text in a tooltip),
 * secondary text where needed, its state, and its menu, with any status line
 * (a clone's failure) under it.
 */
export function RepositoryPickerRow<Item>(props: {
  readonly item: Item;
  readonly icon: ReactNode;
  readonly name: string;
  readonly tooltip?: string;
  readonly detail?: string | null;
  readonly trailing?: ReactNode;
  readonly menu?: ReactNode;
  readonly below?: ReactNode;
  readonly tone?: "default" | "action";
  readonly divider?: boolean;
}) {
  return (
    <>
      <ComboboxItem
        hideIndicator
        value={props.item}
        tone={props.tone ?? "default"}
        divider={props.divider ?? false}
      >
        <ComboboxItemIcon>{props.icon}</ComboboxItemIcon>
        <TruncatedWithTooltip
          text={props.name}
          tooltip={props.tooltip ?? props.name}
          className={cn("min-w-0 text-sm", props.detail ? "shrink" : "flex-1")}
        />
        {props.detail ? (
          <TruncatedWithTooltip
            text={props.detail}
            className="min-w-0 flex-1 text-xs text-muted-foreground"
          />
        ) : null}
        {props.trailing || props.menu ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {props.trailing}
            {props.menu}
          </span>
        ) : null}
      </ComboboxItem>
      {props.below}
    </>
  );
}

/**
 * The GitHub half of "Add repository" while its search is slow or failed:
 * one spinner line, or a single muted line with the reason.
 */
export function GitHubSearchStatus(props: {
  readonly state: OwnerSearchState | undefined;
  readonly owners: ReadonlyArray<string>;
}) {
  const { state } = props;
  const ownerName =
    props.owners.length === 0
      ? "your repositories"
      : props.owners.length === 1
        ? props.owners[0]
        : "linked owners";
  if (state?.status === "loading") {
    return (
      <div className="reveal-motion flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Spinner size="xs" tone="muted" />
        </span>
        <span className="min-w-0 truncate">Searching {ownerName} on GitHub…</span>
      </div>
    );
  }
  if (state?.status === "error") {
    return (
      <p className="reveal-motion select-text break-words py-1 ps-8 pe-2 text-xs text-muted-foreground">
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * A GitHub repository "Add repository" offers: picking it clones it into the
 * project. While this row's clone runs the status line under it shows
 * progress, then the failure with Retry and Dismiss.
 */
export function GitHubRepositoryRow<Item>(props: {
  readonly item: Item;
  readonly repository: ProjectLabelOwnerRepository;
  /** The folder name it gets in the project. */
  readonly name: string;
  readonly clone: ReturnType<typeof useRemoteRepositoryClone>;
  /** This row's clone, when the followed clone is this repository's. */
  readonly view: RemoteCloneView | null;
}) {
  const { repository, view, clone } = props;
  const busy = view?.phase === "starting" || view?.phase === "running";
  return (
    <RepositoryPickerRow
      item={props.item}
      icon={
        busy ? <Spinner size="xs" tone="muted" /> : <GitHubIcon aria-hidden className="size-3.5" />
      }
      name={props.name}
      tooltip={`Clone ${repository.nameWithOwner} into this project`}
      detail={repository.description}
      trailing={
        repository.private ? <LockIcon aria-label="Private" className="size-3 shrink-0" /> : null
      }
      below={
        view ? (
          <RemoteCloneStatus
            key={view.phase}
            view={view}
            repository={repository.nameWithOwner}
            onCancel={() => void clone.cancel()}
            onRetry={() => void clone.retry()}
            onDismiss={() => void clone.dismiss()}
          />
        ) : null
      }
    />
  );
}

/**
 * The GitHub results' last row while they show a preview: picking it lists
 * the rest in place. Searching lists everything anyway.
 */
export function ShowMoreRemoteRow<Item>(props: { readonly item: Item; readonly hidden: number }) {
  return (
    <ComboboxItem hideIndicator value={props.item} tone="action">
      <ComboboxItemIcon>
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </ComboboxItemIcon>
      <span className="min-w-0 flex-1 truncate text-sm">{`Show ${props.hidden} more`}</span>
    </ComboboxItem>
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

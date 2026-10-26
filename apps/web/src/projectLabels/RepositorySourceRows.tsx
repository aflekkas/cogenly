import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectLabelOwnerRepository,
  type RepositoryIdentity,
} from "@cogenly/contracts";
import {
  ChevronDownIcon,
  CircleAlertIcon,
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
import {
  ProjectFavicon,
  RepositoryRemoteIcon,
  type ProjectFaviconProject,
} from "~/components/ProjectFavicon";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ComboboxItem } from "~/components/ui/combobox";
import {
  SearchListRowCheck,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowSubmenu,
  SearchListRowText,
  SearchListRowTrailing,
} from "~/components/ui/search-list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { OwnerSearchState } from "./projectSourceLinks.logic";
import { cloneFailureLine, type RepositoryRowView } from "./repositoryPicker.logic";
import type { RemoteCloneView, useRemoteRepositoryClone } from "./useRemoteRepositoryClone";

/*
 * The pieces every repository row is built from, in the pickers (composer,
 * Start Work, "Add repository") and on the project page: the icon, the
 * one-line state on the selected machine, and the row menu. `RepositoryPickerRow` puts them in a picker row; the project page
 * passes them to its card row.
 */

/** A checkout as its icon reads it: its own icon, and its remote when no link names one. */
export type RepositoryIconLocal = ProjectFaviconProject & {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
};

/**
 * A repository's icon, the same on every surface (pickers, the Work hero,
 * sidebar Work cards): its own (picked in settings, else its favicon) when it
 * has a checkout here, else the icon its remote resolves to on
 * `environmentId` (a checkout's favicon recorded by any machine, else its
 * owner's GitHub avatar), else GitHub's mark for a GitHub remote, else the
 * repository glyph. Without a link's remote, a checkout's own remote stands in.
 */
export function RepositoryRowIcon(props: {
  readonly local: RepositoryIconLocal | null;
  readonly remote: string | null;
  /** The machine to resolve a remote's icon on; null skips that step. */
  readonly environmentId: EnvironmentId | null;
  readonly iconPath?: string | null;
  readonly className?: string;
}) {
  const className = props.className ?? "size-4";
  const identity = props.local?.repositoryIdentity;
  const remote = props.remote ?? (identity ? repositoryGroupingKeyOf(identity) : null);
  const mark = remote?.toLowerCase().startsWith("github.com/") ? (
    <GitHubIcon aria-hidden className="size-3.5" />
  ) : (
    <FolderGit2Icon className={className} />
  );
  const remoteIcon =
    remote !== null && props.environmentId !== null ? (
      <RepositoryRemoteIcon
        environmentId={props.environmentId}
        remote={remote}
        iconPath={props.iconPath ?? null}
        className={className}
        fallback={mark}
      />
    ) : (
      mark
    );
  if (props.local !== null) {
    return <ProjectFavicon project={props.local} className={className} fallback={remoteIcon} />;
  }
  return remoteIcon;
}

/** What a row reads at its end, on the machine it lists for, and what explains it on hover. */
interface RepositoryRowStatusLine {
  /** Swaps fade only between different states; clone progress updates in place. */
  readonly key: string;
  readonly text: string;
  /** The one thing picking the row does about it, after the text. */
  readonly action: string | null;
  readonly busy: boolean;
  readonly alert: boolean;
  readonly tooltip: ReactNode | null;
}

/** A row's state as its end reads it; null once it is cloned there. */
export function repositoryRowStatusLine(input: {
  readonly view: RepositoryRowView;
  readonly name: string;
  readonly remote: string | null;
  /** The machine the list is for, named in "Not on …"; null reads "this machine". */
  readonly machineName: string | null;
}): RepositoryRowStatusLine | null {
  const { view } = input;
  const machine = input.machineName ?? "this machine";
  switch (view.kind) {
    case "ready":
      return null;
    case "needs-clone":
      return {
        key: "needs-clone",
        text: `Not on ${machine}`,
        action: null,
        busy: false,
        alert: false,
        // Only promise a clone where picking the row, or sending, starts one.
        tooltip: view.onSend
          ? `${machine} sets it up when you send: its own checkout, or a fresh clone`
          : view.cloneable
            ? `Pick it to clone it onto ${machine}`
            : null,
      };
    case "starting":
    case "cloning": {
      const percent = view.kind === "cloning" ? view.percent : null;
      return {
        key: "cloning",
        text: percent === null ? "Cloning…" : `Cloning… ${percent}%`,
        action: null,
        busy: true,
        alert: false,
        tooltip: view.kind === "cloning" ? view.progress : null,
      };
    }
    case "failed": {
      const failure = cloneFailureLine(view.message, input.name, input.remote);
      return {
        key: "failed",
        text: failure.reason,
        action: view.cloneable ? (failure.action === "sign-in" ? "Sign in" : "Retry") : null,
        busy: false,
        alert: true,
        tooltip: (
          <span className="block max-w-72 space-y-1 select-text">
            <span className="block">{failure.summary}</span>
            {failure.detail ? (
              <span className="block whitespace-pre-wrap break-words font-mono text-2xs opacity-80">
                {failure.detail}
              </span>
            ) : null}
          </span>
        ),
      };
    }
    case "working":
      return view.work === "unlinking"
        ? null
        : {
            key: `working:${view.work}`,
            text: view.work === "removing" ? `Removing from ${machine}…` : "Moving…",
            action: null,
            busy: true,
            alert: false,
            tooltip: null,
          };
  }
}

/**
 * A row's state on the machine it lists for, on one line at its end: nothing
 * once cloned, "Not on <machine>" (picking it clones it), "Cloning… 40%"
 * with a spinner while the server reports the clone running, or a failure's
 * short reason and the one thing picking the row does about it ("Retry",
 * "Sign in"), with the full account in a tooltip. A change of state fades;
 * progress updates in place, in tabular figures so nothing shifts.
 */
export function RepositoryRowStatus(props: {
  readonly view: RepositoryRowView;
  readonly name: string;
  readonly remote: string | null;
  readonly machineName: string | null;
}) {
  const line = repositoryRowStatusLine(props);
  if (line === null) return null;
  const content = (
    <span
      key={line.key}
      role={line.busy ? "status" : line.alert ? "alert" : undefined}
      className={cn(
        // A fixed cap: the row's trailing slot sizes to its content. The
        // name gives way first; the status truncates only past the cap.
        "swap-motion flex min-w-0 max-w-44 shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground",
      )}
    >
      {line.busy ? <Spinner size="xs" tone="muted" /> : null}
      {line.alert ? (
        <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive-foreground" />
      ) : null}
      <span className="truncate">{line.text}</span>
      {line.action ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0 font-medium text-foreground">{line.action}</span>
        </>
      ) : null}
    </span>
  );
  if (line.tooltip === null) return content;
  return (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipPopup side="top">{line.tooltip}</TooltipPopup>
    </Tooltip>
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
 * One picker row, on one line like every picker row: icon, the repository's
 * name (its full text in a tooltip), secondary text where needed, its state,
 * its menu, and the check while it is the chosen one.
 */
export function RepositoryPickerRow<Item>(props: {
  readonly item: Item;
  readonly icon: ReactNode;
  readonly name: string;
  readonly tooltip?: string;
  readonly detail?: string | null;
  readonly trailing?: ReactNode;
  readonly menu?: ReactNode;
  readonly chosen?: boolean;
  readonly tone?: "default" | "action";
  readonly divider?: boolean;
}) {
  return (
    <ComboboxItem
      hideIndicator
      value={props.item}
      tone={props.tone ?? "default"}
      divider={props.divider ?? false}
    >
      <SearchListRowIcon>{props.icon}</SearchListRowIcon>
      <SearchListRowText layout="inline">
        <TruncatedWithTooltip
          part="label"
          text={props.name}
          tooltip={props.tooltip ?? props.name}
        />
        {props.detail ? <TruncatedWithTooltip part="description" text={props.detail} /> : null}
      </SearchListRowText>
      {props.trailing || props.menu || props.chosen ? (
        <SearchListRowTrailing>
          {props.trailing}
          {props.menu}
          {props.chosen ? <SearchListRowCheck /> : null}
        </SearchListRowTrailing>
      ) : null}
    </ComboboxItem>
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

/** A GitHub repository's clone as its row reads it, the same as a linked repository's. */
function remoteCloneRowView(view: RemoteCloneView | null): RepositoryRowView {
  switch (view?.phase) {
    case "starting":
      return { kind: "starting" };
    case "running":
      return { kind: "cloning", progress: view.summary, percent: percentOf(view.summary) };
    case "failed":
      return { kind: "failed", message: view.message, cloneable: true };
    default:
      return { kind: "ready" };
  }
}

function percentOf(summary: string): number | null {
  const match = /(\d{1,3})%/.exec(summary);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * A GitHub repository "Add repository" offers: picking it clones it into the
 * project, then picks it. The clone shows at the row's end like any
 * repository's ("Cloning… 40%", or a failure's reason with Retry or Sign in);
 * its ⋯ menu cancels a running clone or dismisses a failed one.
 */
export function GitHubRepositoryRow<Item>(props: {
  readonly item: Item;
  readonly repository: ProjectLabelOwnerRepository;
  /** The folder name it gets in the project. */
  readonly name: string;
  readonly clone: ReturnType<typeof useRemoteRepositoryClone>;
  /** This row's clone, when the followed clone is this repository's. */
  readonly view: RemoteCloneView | null;
  /** The machine it would clone onto, which resolves its icon. */
  readonly environmentId: EnvironmentId | null;
}) {
  const { repository, view, clone } = props;
  const remote = `github.com/${repository.nameWithOwner}`;
  const rowView = remoteCloneRowView(view);
  const actions: RepositoryRowMenuAction[] =
    view?.phase === "running"
      ? [
          {
            key: "cancel-clone",
            label: "Cancel clone",
            icon: <XIcon />,
            onSelect: () => void clone.cancel(),
          },
        ]
      : view?.phase === "failed" || view?.phase === "cancelled"
        ? [
            {
              key: "dismiss",
              label: "Dismiss",
              icon: <XIcon />,
              onSelect: () => void clone.dismiss(),
            },
          ]
        : [];
  return (
    <RepositoryPickerRow
      item={props.item}
      icon={<RepositoryRowIcon local={null} remote={remote} environmentId={props.environmentId} />}
      name={props.name}
      tooltip={`Clone ${repository.nameWithOwner} into this project`}
      detail={rowView.kind === "ready" ? repository.description : null}
      trailing={
        rowView.kind === "ready" ? (
          repository.private ? (
            <LockIcon aria-label="Private" className="size-3 shrink-0" />
          ) : null
        ) : (
          <RepositoryRowStatus
            view={rowView}
            name={repository.nameWithOwner}
            remote={remote}
            machineName={null}
          />
        )
      }
      menu={<RepositoryRowMenu label={`${props.name} clone`} actions={actions} />}
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
      <PickerRowContent
        icon={<ChevronDownIcon aria-hidden className="size-3.5" />}
        label={`Show ${props.hidden} more`}
      />
    </ComboboxItem>
  );
}

/**
 * A picker row that is an icon and a label, such as "Add repository…" or
 * "Back". `chosen` checks the row holding the picker's value; `submenu` marks
 * a row that opens a nested list.
 */
export function PickerRowContent(props: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly chosen?: boolean;
  readonly submenu?: boolean;
}) {
  return (
    <>
      <SearchListRowIcon>{props.icon}</SearchListRowIcon>
      <SearchListRowText>
        <SearchListRowLabel>{props.label}</SearchListRowLabel>
      </SearchListRowText>
      {props.chosen || props.submenu ? (
        <SearchListRowTrailing>
          {props.chosen ? <SearchListRowCheck /> : null}
          {props.submenu ? <SearchListRowSubmenu /> : null}
        </SearchListRowTrailing>
      ) : null}
    </>
  );
}

/** A row's label or description, truncated, with the full text in a tooltip. */
function TruncatedWithTooltip(props: {
  readonly part: "label" | "description";
  readonly text: string;
  readonly tooltip?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={props.part === "label" ? <SearchListRowLabel /> : <SearchListRowDescription />}
      >
        {props.text}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? props.text}</TooltipPopup>
    </Tooltip>
  );
}

/** The "Manage repositories…" row's look, shared by every repository picker. */
export function ManageRepositoriesRowContent() {
  return (
    <PickerRowContent icon={<Settings2Icon className="size-4" />} label="Manage repositories…" />
  );
}

/** The "No repository (project folder)" row's mark: the folder itself, not the project's colour. */
export function ProjectFolderRowIcon(props: { readonly className?: string }) {
  return <FolderIcon className={props.className ?? "size-4"} />;
}

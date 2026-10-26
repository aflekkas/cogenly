import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import { scopeThreadRef, scopedThreadKey } from "@cogenly/client-runtime/environment";
import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/shell";
import type {
  ChatAttachmentId,
  EnvironmentId,
  ProjectId,
  ProjectLabelWithRepositories,
  ProjectResource,
  ProjectSourceLink,
} from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ClockIcon,
  FileIcon,
  FolderGit2Icon,
  HammerIcon,
  LinkIcon,
  MessageCircleIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";

import { useAgents, useAgentsClient } from "../../agents/agentsClient";
import type { AgentContact } from "../../agents/agents.types";
import { requestConfirmDialog } from "../../confirmDialog";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { formatBytes } from "../../lib/formatBytes";
import { randomUUID } from "../../lib/utils";
import type { EnvironmentProjectLabel } from "../../projectLabels/projectLabels.logic";
import { ProjectRepositoryPicker } from "../../projectLabels/ProjectRepositoryPicker";
import { ProjectSourceLinkField } from "../../projectLabels/ProjectSourceLinks";
import {
  projectExtraSourceLinks,
  projectGitHubOrg,
  projectSourceLinkKey,
  projectSourceLinkLabel,
  sortProjectSourceLinks,
} from "../../projectLabels/projectSourceLinks.logic";
import {
  cloneFailureLine,
  gitHubRepositoryOf,
  repositoryRowAction,
} from "../../projectLabels/repositoryPicker.logic";
import {
  RepositoryRowIcon,
  RepositoryRowMenu,
  RepositoryRowStatus,
} from "../../projectLabels/RepositorySourceRows";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import {
  useRepositoryCheckouts,
  useRepositoryRowActions,
} from "../../projectLabels/useRepositoryCheckout";
import type { RepositoryRow } from "../../projectLabels/useRepositoryPicker";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AnimatedHeight } from "../AnimatedHeight";
import { avatarFaceProps } from "../agents/face/agentAvatar.logic";
import { AgentFace } from "../agents/face";
import { GitHubIcon } from "../Icons";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { chatActivityAt } from "../sidebar/modes/sidebarModes.logic";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  ProjectCard,
  ProjectCardAddButton,
  ProjectCardNote,
  ProjectCardRow,
  useArrivedKeys,
} from "./ProjectCard";
import { mixProjectRecent, projectRecentPip, type ProjectRecentPip } from "./projectHome.logic";
import { sortRecentFirst } from "./projectPanel.logic";

const NO_PERMISSION = "You don't have permission to change projects here.";

/** Removals in flight, so their rows fade while the server drops them. */
function useRemoving() {
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const run = async (key: string, action: () => Promise<void>) => {
    setRemoving((current) => new Set([...current, key]));
    try {
      await action();
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  return { removing, run };
}

async function confirmRemoval(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message)
  );
}

/**
 * Every repository the project links, as the pickers list it, with its state
 * on the selected machine: one not cloned there reads "Not on <machine>" and
 * clicking it clones it, a failed clone retries or opens GitHub sign-in; a cloned one opens its settings. Its ⋯ menu moves
 * it into the project folder, removes it from that machine, or takes it out
 * of the project. A project on several machines switches between them.
 */
export function RepositoriesCard(props: {
  readonly environmentId: EnvironmentId;
  readonly folder: EnvironmentProjectLabel;
  /** `linkedRepositoryRows` for the project on this machine. */
  readonly rows: ReadonlyArray<RepositoryRow>;
  readonly onOpenRepository: (repositoryId: ProjectId) => void;
  /** The machines that have the project, when more than one does. */
  readonly machines?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onSelectMachine?: (environmentId: EnvironmentId) => void;
}) {
  const { environmentId, rows } = props;
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelRepository.permissionAtom(environmentId),
  );
  const checkouts = useRepositoryCheckouts(environmentId);
  const rowActions = useRepositoryRowActions(environmentId, checkouts);
  const navigate = useNavigate();
  const machineName =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.label ?? null;
  const openSignIn = () =>
    void navigate({ to: "/settings/source-control", search: { machine: environmentId } });
  const arrived = useArrivedKeys(
    rows.map((row) => row.key),
    true,
  );
  const rowIcon = (row: RepositoryRow) => (
    <RepositoryRowIcon
      local={row.local}
      remote={row.remote}
      environmentId={environmentId}
      iconPath={row.iconPath}
      className="size-3.5"
    />
  );
  return (
    <ProjectCard
      icon={<FolderGit2Icon />}
      title="Repositories"
      count={rows.length}
      add={
        <span className="flex items-center gap-1">
          {props.machines && props.machines.length > 1 ? (
            <ToggleGroup
              aria-label="Checkouts on"
              variant="segmented"
              value={[environmentId]}
              onValueChange={(next) => {
                const picked = props.machines?.find((machine) => machine.environmentId === next[0]);
                if (picked) props.onSelectMachine?.(picked.environmentId);
              }}
            >
              {props.machines.map((machine) => (
                <Toggle key={machine.environmentId} value={machine.environmentId}>
                  {machine.label}
                </Toggle>
              ))}
            </ToggleGroup>
          ) : null}
          <ProjectRepositoryPicker
            folder={props.folder}
            disabled={!canLink}
            triggerLabel="Add repository"
            iconOnly
          />
        </span>
      }
      isEmpty={rows.length === 0}
      empty="No repositories yet. Add one from this machine or GitHub, and its Work files here too."
    >
      {/* A machine switch fades its rows in place. */}
      <div key={environmentId} className="swap-motion flex flex-col">
        {rows.map((row) => {
          const view = checkouts.viewOf(row);
          const action = repositoryRowAction(row);
          const { project, repositoryId } = row;
          const cloneable =
            (view.kind === "needs-clone" || view.kind === "failed") && view.cloneable;
          // A clone that needs a GitHub sign-in on this machine opens it.
          const signIn =
            view.kind === "failed" &&
            view.cloneable &&
            cloneFailureLine(view.message, row.name, row.remote).action === "sign-in";
          const onOpen =
            action === "select" && repositoryId !== null && view.kind === "ready"
              ? () => props.onOpenRepository(repositoryId)
              : signIn
                ? openSignIn
                : cloneable && project !== null
                  ? () => void checkouts.start({ ...row, project })
                  : undefined;
          return (
            <ProjectCardRow
              key={row.key}
              icon={rowIcon(row)}
              title={row.name}
              meta={
                // Once cloned, the GitHub repository it came from, as before.
                view.kind === "ready" ? (
                  (row.detail ?? gitHubRepositoryOf(row.local?.repositoryIdentity) ?? undefined)
                ) : (
                  <RepositoryRowStatus
                    view={view}
                    name={row.name}
                    remote={row.remote}
                    machineName={machineName}
                  />
                )
              }
              arrived={arrived.has(row.key)}
              removing={view.kind === "working" && view.work === "unlinking"}
              {...(onOpen ? { onOpen } : {})}
              ariaLabel={
                signIn
                  ? `Sign in to GitHub on ${machineName ?? "this machine"} to clone ${row.name}`
                  : cloneable
                    ? `Clone ${row.name} to ${machineName ?? "this machine"}`
                    : view.kind === "ready"
                      ? `Repository settings for ${row.name}`
                      : row.name
              }
              menu={<RepositoryRowMenu label={`${row.name} actions`} actions={rowActions(row)} />}
            />
          );
        })}
      </div>
    </ProjectCard>
  );
}

export function SourcesCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
}) {
  const { environmentId, label } = props;
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelSource.permissionAtom(environmentId),
  );
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelSource.permissionAtom(environmentId),
  );
  const unlinkSource = useAtomCommand(serverEnvironment.unlinkProjectLabelSource, {
    label: "unlink project source",
    reportFailure: false,
  });
  const [linking, setLinking] = useState(false);
  const { removing, run } = useRemoving();
  // The org is the project's setting (in the page header); Sources lists the rest.
  const org = projectGitHubOrg(label.sourceLinks);
  const links =
    org === null
      ? sortProjectSourceLinks(label.sourceLinks)
      : projectExtraSourceLinks(label.sourceLinks);
  const arrived = useArrivedKeys(links.map(projectSourceLinkKey), true);
  // Unlinking only forgets the link; nothing on GitHub or disk changes, so no confirm.
  const remove = (link: ProjectSourceLink) =>
    run(projectSourceLinkKey(link), async () => {
      const result = await unlinkSource({ environmentId, input: { id: label.id, link } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not unlink ${projectSourceLinkLabel(link)}`, result);
      }
    });
  return (
    <ProjectCard
      icon={<LinkIcon />}
      title="Sources"
      count={links.length}
      add={
        <ProjectCardAddButton
          icon={<PlusIcon />}
          label={linking ? "Done linking" : "Link GitHub"}
          title={canLink ? undefined : NO_PERMISSION}
          disabled={!canLink && !linking}
          expanded={linking}
          onClick={() => setLinking((current) => !current)}
        />
      }
    >
      {links.length === 0 && !linking ? (
        <p className="px-1.5 pt-0.5 pb-1.5 text-xs/relaxed text-muted-foreground">
          {org === null
            ? "Link a GitHub org or repository so agents and the repository picker can reach it."
            : `Repositories outside ${org} that agents and the repository picker should reach.`}
        </p>
      ) : null}
      {links.map((link) => {
        const key = projectSourceLinkKey(link);
        const text = projectSourceLinkLabel(link);
        return (
          <ProjectCardRow
            key={key}
            icon={<GitHubIcon />}
            title={text}
            meta={link.kind === "github-owner" ? "org" : "repo"}
            arrived={arrived.has(key)}
            removing={removing.has(key)}
            onRemove={() => void remove(link)}
            removeLabel={`Unlink ${text}`}
            removeDisabledReason={canUnlink ? null : NO_PERMISSION}
          />
        );
      })}
      <AnimatedHeight>
        {linking ? (
          <div className="reveal-motion px-1 pt-1 pb-1">
            <ProjectSourceLinkField
              environmentId={environmentId}
              label={label}
              autoFocus
              onLinked={() => setLinking(false)}
            />
          </div>
        ) : null}
      </AnimatedHeight>
    </ProjectCard>
  );
}

function resourceName(resource: ProjectResource): string {
  return resource.relativePath.slice(resource.relativePath.lastIndexOf("/") + 1);
}

/** The project's files on disk, newest first. The whole card takes a drop; "+" picks files. */
export function FilesCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly resources: ReadonlyArray<ProjectResource>;
  readonly loaded: boolean;
  readonly error: string | null;
}) {
  const { environmentId, label } = props;
  const canAdd = useAtomValue(
    serverEnvironment.addProjectLabelResource.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.removeProjectLabelResource.permissionAtom(environmentId),
  );
  const addResource = useAtomCommand(serverEnvironment.addProjectLabelResource, {
    label: "add project file",
    reportFailure: false,
  });
  const removeResource = useAtomCommand(serverEnvironment.removeProjectLabelResource, {
    label: "remove project file",
    reportFailure: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const { removing, run } = useRemoving();
  const files = useMemo(
    () =>
      sortRecentFirst(
        props.resources.filter((resource) => resource.kind === "file"),
        (resource) => resource.modifiedAt,
      ),
    [props.resources],
  );
  const arrived = useArrivedKeys(
    files.map((resource) => resource.relativePath),
    props.loaded,
  );

  const upload = async (file: File) => {
    const id = randomUUID() as ChatAttachmentId;
    setUploading((count) => count + 1);
    try {
      startAttachmentUpload({
        environmentId,
        image: {
          type: "file",
          id,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          file,
        },
      });
      await awaitAttachmentUploads([id]);
      const state = readAttachmentUpload(id);
      if (state?.status !== "ready") {
        releaseAttachmentUpload(id);
        toastManager.add({
          type: "error",
          title: `Could not upload ${file.name}`,
          description: "The upload did not finish.",
        });
        return;
      }
      const result = await addResource({
        environmentId,
        input: {
          id: label.id,
          resource: { kind: "upload", attachmentId: state.attachmentId, fileName: file.name },
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not add ${file.name}`, result);
      }
    } finally {
      setUploading((count) => count - 1);
    }
  };
  const uploadAll = (list: FileList | null) => {
    if (!canAdd || list === null) return;
    for (const file of Array.from(list)) void upload(file);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    uploadAll(event.dataTransfer.files);
  };
  const remove = (resource: ProjectResource) =>
    run(resource.relativePath, async () => {
      const name = resourceName(resource);
      const confirmed = await confirmRemoval(
        `Delete ${name}?\nIt is removed from the project's folder on disk.`,
      );
      if (!confirmed) return;
      const result = await removeResource({
        environmentId,
        input: { id: label.id, relativePath: resource.relativePath },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not remove ${name}`, result);
      }
    });

  const note =
    uploading > 0
      ? `Adding ${uploading} ${uploading === 1 ? "file" : "files"}…`
      : props.error !== null
        ? props.error
        : !props.loaded
          ? "Loading files…"
          : null;
  return (
    <div
      className="rounded-xl transition-[box-shadow] duration-(--motion-duration-fast) ease-standard data-dragging:ring-2 data-dragging:ring-ring motion-reduce:transition-none"
      data-dragging={dragging && canAdd ? "" : undefined}
      onDragOver={(event) => {
        if (!canAdd || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          uploadAll(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <ProjectCard
        icon={<FileIcon />}
        title="Files"
        count={files.length}
        add={
          <ProjectCardAddButton
            icon={<PlusIcon />}
            label="Add files"
            title={canAdd ? undefined : NO_PERMISSION}
            disabled={!canAdd}
            onClick={() => inputRef.current?.click()}
          />
        }
        isEmpty={files.length === 0 && note === null}
        empty={
          canAdd ? (
            <>
              Drop files here. They land in the project's <code>Resources</code> folder.
            </>
          ) : (
            NO_PERMISSION
          )
        }
      >
        {files.map((resource) => {
          const name = resourceName(resource);
          return (
            <ProjectCardRow
              key={resource.relativePath}
              icon={<FileIcon />}
              title={name}
              meta={formatBytes(resource.sizeBytes)}
              arrived={arrived.has(resource.relativePath)}
              removing={removing.has(resource.relativePath)}
              onRemove={() => void remove(resource)}
              removeLabel={`Delete ${name}`}
              removeDisabledReason={canRemove ? null : NO_PERMISSION}
            />
          );
        })}
        {note !== null ? <ProjectCardNote>{note}</ProjectCardNote> : null}
      </ProjectCard>
    </div>
  );
}

const PIP_LABEL: Record<NonNullable<ProjectRecentPip>, string> = {
  running: "Working",
  "needs-you": "Needs you",
  failed: "Failed",
  done: "Done",
};

/**
 * The project's latest chats and Work in one list, with the sidebar's status
 * colours. Removing one archives it, with the usual undo toast.
 */
export function RecentCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly chats: ReadonlyArray<EnvironmentThreadShell>;
  readonly work: ReadonlyArray<EnvironmentThreadShell>;
  /** Threads shown elsewhere on the page (the project chat). */
  readonly exclude: ReadonlySet<string>;
}) {
  const { environmentId, label } = props;
  const navigate = useNavigate();
  const { startScratchThread } = useScratchProject();
  const { archiveThread } = useThreadActions();
  const { removing, run } = useRemoving();
  const recent = mixProjectRecent({
    chats: props.chats,
    work: props.work,
    keyOf: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    activityAt: chatActivityAt,
    exclude: props.exclude,
  });
  const arrived = useArrivedKeys(
    recent.items.map((item) => item.key),
    true,
  );
  const archive = (thread: EnvironmentThreadShell, key: string) =>
    run(key, async () => {
      const result = await archiveThread(scopeThreadRef(thread.environmentId, thread.id));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not archive ${thread.title}`, result);
      }
    });
  const start = (surface: "chat" | "work") =>
    void startScratchThread(environmentId, { surface, projectFolderId: label.id });
  return (
    <ProjectCard
      icon={<ClockIcon />}
      title="Recent"
      count={recent.items.length + recent.hidden}
      add={
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="New chat or Work" />}
          >
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => start("chat")}>
              <SquarePenIcon />
              New chat
            </MenuItem>
            <MenuItem onClick={() => start("work")}>
              <HammerIcon />
              New Work
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
      isEmpty={recent.items.length === 0}
      empty="Chats and Work you start in this project show up here."
    >
      {recent.items.map((item) => {
        const { thread } = item;
        const pip = projectRecentPip({
          kind: item.kind,
          status: resolveSidebarThreadStatus(thread),
          latestRunCompleted: thread.latestRun?.status === "completed",
        });
        return (
          <ProjectCardRow
            key={item.key}
            icon={item.kind === "work" ? <HammerIcon /> : <MessageCircleIcon />}
            title={thread.title}
            pip={pip}
            pipLabel={pip ? PIP_LABEL[pip] : undefined}
            meta={formatRelativeTimeLabel(chatActivityAt(thread))}
            arrived={arrived.has(item.key)}
            removing={removing.has(item.key)}
            onOpen={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              })
            }
            onRemove={() => void archive(thread, item.key)}
            removeLabel={`Archive ${thread.title}`}
          />
        );
      })}
      {recent.hidden > 0 ? (
        <ProjectCardNote>{`${recent.hidden} more in the sidebar`}</ProjectCardNote>
      ) : null}
    </ProjectCard>
  );
}

/**
 * Agents whose conversation is filed in this project. "+" files one that
 * lives elsewhere, or starts a new one here; removing only unfiles it.
 */
export function AgentsCard(props: {
  readonly environmentId: EnvironmentId;
  /** Every machine that has the project; the agents listed from any of them count. */
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
  readonly label: ProjectLabelWithRepositories;
}) {
  const { environmentId, label } = props;
  const navigate = useNavigate();
  const { agents, loading } = useAgents();
  const client = useAgentsClient();
  const { removing, run } = useRemoving();
  const machines = props.environmentIds ?? [environmentId];
  const here = agents.filter(
    (agent) => machines.includes(agent.environmentId) && agent.projectFolderId === label.id,
  );
  const elsewhere = agents.filter(
    (agent) => machines.includes(agent.environmentId) && agent.projectFolderId !== label.id,
  );
  const arrived = useArrivedKeys(
    here.map((agent) => agent.id),
    !loading,
  );
  const move = async (agent: AgentContact, folder: typeof label.id | null) => {
    try {
      await client.setProject(agent, folder);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: folder ? `Could not assign ${agent.name}` : `Could not unfile ${agent.name}`,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const open = (agent: AgentContact) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(agent.environmentId, agent.conversationThreadId),
      ),
    });
  return (
    <ProjectCard
      icon={<BotIcon />}
      title="Agents"
      count={here.length}
      add={
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="Assign an agent" />}
          >
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {elsewhere.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Move here</MenuGroupLabel>
                {elsewhere.map((agent) => (
                  <MenuItem key={agent.id} onClick={() => void move(agent, label.id)}>
                    <AgentFace {...avatarFaceProps(agent.avatar)} size={16} />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </MenuItem>
                ))}
              </MenuGroup>
            ) : null}
            <MenuItem
              onClick={() =>
                void navigate({
                  to: "/agents/new",
                  search: { environmentId, projectFolderId: label.id },
                })
              }
            >
              <PlusIcon />
              New agent…
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
      isEmpty={here.length === 0}
      empty="No agents here yet. Assign one and it works inside this project."
    >
      {here.map((agent) => (
        <ProjectCardRow
          key={agent.id}
          icon={<AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={14} />}
          title={agent.name}
          meta={agent.unreadCount > 0 ? `${agent.unreadCount} new` : undefined}
          arrived={arrived.has(agent.id)}
          removing={removing.has(agent.id)}
          onOpen={() => open(agent)}
          onRemove={() => void run(agent.id, () => move(agent, null))}
          removeLabel={`Take ${agent.name} out of ${label.name}`}
        />
      ))}
    </ProjectCard>
  );
}

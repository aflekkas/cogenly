import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ChatAttachmentId,
  EnvironmentId,
  ProjectId,
  ProjectLabelWithRepositories,
  ProjectResource,
  ProjectSourceLink,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  BrainIcon,
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
import type { useEnvironmentRepositories } from "../../projectLabels/ProjectLabelEditorDialog";
import { ProjectRepositoryPicker } from "../../projectLabels/ProjectRepositoryPicker";
import { ProjectSourceLinkField } from "../../projectLabels/ProjectSourceLinks";
import {
  projectSourceLinkKey,
  projectSourceLinkLabel,
  sortProjectSourceLinks,
} from "../../projectLabels/projectSourceLinks.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  ProjectCard,
  ProjectCardAddButton,
  ProjectCardNote,
  ProjectCardRow,
  useArrivedKeys,
} from "./ProjectCard";
import {
  instructionsSaveState,
  mixProjectRecent,
  normalizeInstructions,
  projectRecentPip,
  type ProjectRecentPip,
} from "./projectHome.logic";
import { sortRecentFirst } from "./projectPanel.logic";
import type { ProjectInstructions } from "./useProjectInstructions";

const NO_PERMISSION = "You don't have permission to change projects here.";

type Repositories = ReturnType<typeof useEnvironmentRepositories>;

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
 * Standing instructions for every chat and Work in the project, edited in
 * place. Saves on blur or ⌘/Ctrl+Enter; the line under it says where the
 * draft stands.
 */
export function InstructionsCard(props: {
  readonly instructions: ProjectInstructions;
  readonly canEdit: boolean;
}) {
  const { instructions } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const value = draft ?? instructions.value;
  const state = instructionsSaveState({
    draft: value,
    saved: instructions.value,
    saving,
    failed,
  });
  const save = async () => {
    if (draft === null || state === "saved" || saving || !props.canEdit) return;
    setSaving(true);
    const ok = await instructions.save(normalizeInstructions(draft));
    setSaving(false);
    setFailed(!ok);
  };
  // Once the server's copy matches the draft, follow it again, so another
  // device's edit shows. Waiting for the match keeps the old text from flashing.
  if (draft !== null && !saving && draft === instructions.value) setDraft(null);
  const disabledReason = props.canEdit ? null : NO_PERMISSION;
  const status =
    disabledReason ??
    (state === "saving"
      ? "Saving…"
      : state === "failed"
        ? "Couldn't save. Try again."
        : state === "unsaved"
          ? "Unsaved · saves when you leave the field."
          : instructions.value.trim().length > 0
            ? "Applies to new turns in this project. Running Claude sessions pick it up after a restart."
            : "Tell the chat “remember that…”, or write them here.");
  return (
    <ProjectCard icon={<BrainIcon />} title="Instructions">
      <div className="flex flex-col gap-1.5 px-1 pt-0.5 pb-1">
        <Textarea
          size="sm"
          aria-label="Project instructions"
          placeholder="How agents should work in this project…"
          value={value}
          disabled={disabledReason !== null}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setFailed(false);
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              setDraft(null);
              setFailed(false);
            }
          }}
        />
        <p
          role="status"
          className="min-h-4 px-0.5 text-2xs text-muted-foreground"
          data-state={state}
        >
          <span key={status} className="swap-motion">
            {status}
          </span>
        </p>
      </div>
    </ProjectCard>
  );
}

export function RepositoriesCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly folder: EnvironmentProjectLabel;
  readonly repositories: Repositories;
  readonly linkedRepositories: Repositories;
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
  readonly onOpenRepository: (repositoryId: ProjectId) => void;
}) {
  const { environmentId, label } = props;
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelRepository.permissionAtom(environmentId),
  );
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelRepository.permissionAtom(environmentId),
  );
  const unlink = useAtomCommand(serverEnvironment.unlinkProjectLabelRepository, {
    label: "remove repository from project",
    reportFailure: false,
  });
  const { removing, run } = useRemoving();
  const arrived = useArrivedKeys(
    props.linkedRepositories.map((repository) => repository.id),
    true,
  );
  const remove = (repositoryId: ProjectId, title: string) =>
    run(repositoryId, async () => {
      const confirmed = await confirmRemoval(
        `Remove ${title} from ${label.name}?\nThe repository stays on disk, and its Work leaves the project with it.`,
      );
      if (!confirmed) return;
      const result = await unlink({ environmentId, input: { labelId: label.id, repositoryId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not remove ${title}`, result);
      }
    });
  return (
    <ProjectCard
      icon={<FolderGit2Icon />}
      title="Repositories"
      count={props.linkedRepositories.length}
      add={
        <ProjectRepositoryPicker
          folder={props.folder}
          repositories={props.repositories}
          folderByRepository={props.folderByRepository}
          disabled={!canLink}
          triggerLabel="Add repository"
          iconOnly
        />
      }
      isEmpty={props.linkedRepositories.length === 0}
      empty="No repositories yet. Add one from this machine, and its Work files here too."
    >
      {props.linkedRepositories.map((repository) => (
        <ProjectCardRow
          key={repository.id}
          icon={<FolderGit2Icon />}
          title={repository.title}
          arrived={arrived.has(repository.id)}
          removing={removing.has(repository.id)}
          onOpen={() => props.onOpenRepository(repository.id)}
          ariaLabel={`Repository settings for ${repository.title}`}
          onRemove={() => void remove(repository.id, repository.title)}
          removeLabel={`Remove ${repository.title} from ${label.name}`}
          removeDisabledReason={canUnlink ? null : NO_PERMISSION}
        />
      ))}
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
  const links = sortProjectSourceLinks(label.sourceLinks);
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
          Link a GitHub org or repository so agents and the repository picker can reach it.
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
  readonly label: ProjectLabelWithRepositories;
}) {
  const { environmentId, label } = props;
  const navigate = useNavigate();
  const { agents, loading } = useAgents();
  const client = useAgentsClient();
  const { removing, run } = useRemoving();
  const here = agents.filter(
    (agent) => agent.environmentId === environmentId && agent.projectFolderId === label.id,
  );
  const elsewhere = agents.filter(
    (agent) => agent.environmentId === environmentId && agent.projectFolderId !== label.id,
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

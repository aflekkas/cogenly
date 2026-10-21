import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatAttachmentId,
  EnvironmentId,
  ProjectLabelId,
  ProjectResource,
} from "@t3tools/contracts";
import { FileIcon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { useState, type DragEvent as ReactDragEvent } from "react";

import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { formatBytes } from "../../lib/formatBytes";
import { cn, randomUUID } from "../../lib/utils";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { ProjectPanelRow, ProjectPanelSection } from "./ProjectPanelSection";
import { sortRecentFirst } from "./projectPanel.logic";

const NO_PERMISSION = "You don't have permission to change projects here.";

function resourceName(resource: ProjectResource): string {
  return resource.relativePath.slice(resource.relativePath.lastIndexOf("/") + 1);
}

/**
 * The project's files on disk, newest first, with a drop zone that uploads
 * into the folder and a way to remove one. "Open folder" shows once a caller
 * can reveal the folder on this machine.
 */
export function ProjectFilesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
  readonly resources: ReadonlyArray<ProjectResource>;
  readonly loaded: boolean;
  /** Why the list could not load, in the server's words. */
  readonly error: string | null;
  /** Reveals the project's folder; absent until the desktop bridge can. */
  readonly onOpenFolder?: (() => void) | null;
}) {
  const { environmentId, labelId } = props;
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
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const files = sortRecentFirst(
    props.resources.filter((resource) => resource.kind === "file"),
    (resource) => resource.modifiedAt,
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
          id: labelId,
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
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canAdd) return;
    for (const file of Array.from(event.dataTransfer.files)) void upload(file);
  };
  const remove = async (resource: ProjectResource) => {
    const result = await removeResource({
      environmentId,
      input: { id: labelId, relativePath: resource.relativePath },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(`Could not remove ${resourceName(resource)}`, result);
    }
  };

  return (
    <ProjectPanelSection
      title="Files"
      count={files.length}
      action={
        props.onOpenFolder ? (
          <Button size="xs" variant="ghost-muted" onClick={props.onOpenFolder}>
            <FolderOpenIcon />
            Open folder
          </Button>
        ) : undefined
      }
    >
      <div
        // The whole section takes a drop; the line below says so.
        className={cn(
          "flex flex-col gap-px rounded-md transition-colors duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none",
          dragging && canAdd && "state-selected",
        )}
        onDragOver={(event) => {
          if (!canAdd) return;
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        {files.map((resource) => (
          <ProjectPanelRow
            key={resource.relativePath}
            icon={resource.kind === "folder" ? <FolderIcon /> : <FileIcon />}
            title={resourceName(resource)}
            meta={formatBytes(resource.sizeBytes)}
            trailing={formatRelativeTimeLabel(resource.modifiedAt)}
            actions={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${resourceName(resource)}`}
                title={canRemove ? "Remove from project" : NO_PERMISSION}
                disabled={!canRemove}
                onClick={() => void remove(resource)}
              >
                <XIcon />
              </Button>
            }
          />
        ))}
        <p className="flex min-h-9 items-center px-2.5 text-sm text-muted-foreground">
          {uploading > 0
            ? `Adding ${uploading} ${uploading === 1 ? "file" : "files"}…`
            : props.error !== null
              ? props.error
              : !props.loaded
                ? "Loading files…"
                : canAdd
                  ? "Drop files here to add them."
                  : NO_PERMISSION}
        </p>
      </div>
    </ProjectPanelSection>
  );
}

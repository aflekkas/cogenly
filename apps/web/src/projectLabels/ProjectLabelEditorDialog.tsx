import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { cn } from "../lib/utils";
import { useProjects, useServerConfigs } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { PROJECT_LABEL_COLORS } from "./projectLabels.logic";

function reportFailure(title: string, result: { readonly cause: Cause.Cause<unknown> }) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/** Repositories (Cogenly projects) on one environment, minus the scratch chat workspace. */
export function useEnvironmentRepositories(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  return useMemo(() => {
    if (environmentId === null) return [];
    const scratchRoot = serverConfigs.get(environmentId)?.scratchWorkspaceRoot ?? null;
    return projects
      .filter(
        (project) =>
          project.environmentId === environmentId && !isScratchProject(project, scratchRoot),
      )
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }, [environmentId, projects, serverConfigs]);
}

/**
 * Deletes a folder after the confirmation that says its contents are only
 * unfiled. Resolves true once it is gone.
 */
export function useDeleteProjectFolder() {
  const deleteLabel = useAtomCommand(serverEnvironment.deleteProjectLabel, {
    label: "delete project",
    reportFailure: false,
  });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      label: { readonly id: ProjectLabelId; readonly name: string },
    ): Promise<boolean> => {
      const message = `Delete ${label.name}?\nIts chats, Work and repositories are kept, just no longer in a folder.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return false;
      const result = await deleteLabel({ environmentId, input: { id: label.id } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) reportFailure("Could not delete project", result);
        return false;
      }
      return true;
    },
    [deleteLabel],
  );
}

/**
 * Create or edit one project folder: name, color, description, and delete.
 * Repositories are added and removed from the folder's view.
 */
export function ProjectLabelEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories | null;
  readonly onClose: () => void;
  /** After a create, so the caller can open the new folder. */
  readonly onCreated?: (labelId: ProjectLabelId) => void;
  /** After a delete, so a view of the deleted project can leave. */
  readonly onDeleted?: () => void;
}) {
  const { environmentId, label, onClose } = props;
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState<string | undefined>(label?.color ?? "blue");
  const [description, setDescription] = useState(label?.description ?? "");
  const [saving, setSaving] = useState(false);
  const createLabel = useAtomCommand(serverEnvironment.createProjectLabel, "create project");
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, "update project");
  const deleteFolder = useDeleteProjectFolder();
  const trimmedName = name.trim();

  const save = async () => {
    if (trimmedName.length === 0 || saving) return;
    setSaving(true);
    try {
      let labelId: ProjectLabelId;
      if (label === null) {
        const created = await createLabel({
          environmentId,
          input: {
            name: trimmedName,
            ...(color ? { color } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
          },
        });
        if (created._tag === "Failure") {
          if (!isAtomCommandInterrupted(created))
            reportFailure("Could not create project", created);
          return;
        }
        labelId = created.value.label.id;
      } else {
        labelId = label.id;
        const nextDescription = description.trim();
        if (
          trimmedName !== label.name ||
          color !== label.color ||
          nextDescription !== (label.description ?? "")
        ) {
          const updated = await updateLabel({
            environmentId,
            input: {
              id: label.id,
              name: trimmedName,
              color: color ?? null,
              description: nextDescription.length > 0 ? nextDescription : null,
            },
          });
          if (updated._tag === "Failure") {
            if (!isAtomCommandInterrupted(updated))
              reportFailure("Could not save project", updated);
            return;
          }
        }
      }
      onClose();
      if (label === null) props.onCreated?.(labelId);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (label === null || saving) return;
    setSaving(true);
    const deleted = await deleteFolder(environmentId, label);
    setSaving(false);
    if (!deleted) return;
    onClose();
    props.onDeleted?.();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{label ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>
            A folder for chats, Work and the repositories they touch.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="project-label-editor"
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="project-label-name">Name</Label>
                <Input
                  id="project-label-name"
                  autoFocus
                  value={name}
                  maxLength={200}
                  placeholder="Spawn Partners"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Color</div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Project color">
                  {PROJECT_LABEL_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={color === option.value}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        color === option.value && "border-foreground/64",
                      )}
                      onClick={() => setColor(option.value)}
                    >
                      <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-label-description">Description</Label>
                <Textarea
                  id="project-label-description"
                  value={description}
                  maxLength={4000}
                  placeholder="What belongs here"
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          {label ? (
            <Button
              variant="destructive-outline"
              size="sm"
              className="sm:me-auto"
              disabled={saving}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          ) : null}
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            type="submit"
            form="project-label-editor"
            size="sm"
            disabled={saving || trimmedName.length === 0}
          >
            {label ? "Save" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { isScratchProject } from "@cogenly/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@cogenly/contracts";
import type * as Cause from "effect/Cause";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { ProjectColorPicker } from "../components/ProjectColorPicker";
import {
  Dialog,
  DialogClose,
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
import { useProjects, useServerConfigs } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { projectLabelPaletteColor } from "./projectLabels.logic";

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
  /** A new project's starting name, such as what was typed into a picker's search. */
  readonly initialName?: string;
  /** A new project's starting color; blue when omitted. */
  readonly initialColor?: string;
  /** After a create, so the caller can open the new folder or file something into it. */
  readonly onCreated?: (labelId: ProjectLabelId, name: string) => void;
  /** After a delete, so a view of the deleted project can leave. */
  readonly onDeleted?: () => void;
}) {
  const { environmentId, label, onClose } = props;
  const [name, setName] = useState(label?.name ?? props.initialName ?? "");
  const [color, setColor] = useState<string | undefined>(
    label?.color ?? props.initialColor ?? "blue",
  );
  const [description, setDescription] = useState(label?.description ?? "");
  const [descriptionFocused, setDescriptionFocused] = useState(false);
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
            ...(color ? { color: projectLabelPaletteColor(color) } : {}),
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
              color: color === undefined ? null : projectLabelPaletteColor(color),
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
      if (label === null) props.onCreated?.(labelId, trimmedName);
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
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle size="sm">{label ? "Edit project" : "New project"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id="project-label-editor"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-4">
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
                <Label id="project-label-color" render={<span />}>
                  Color
                </Label>
                <ProjectColorPicker
                  value={color}
                  onChange={setColor}
                  label="Project color"
                  labelledBy="project-label-color"
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-label-description">
                  Description
                  <span className="font-normal text-muted-foreground">Optional</span>
                </Label>
                <Textarea
                  id="project-label-description"
                  collapsed={!descriptionFocused}
                  value={description}
                  maxLength={4000}
                  placeholder="What belongs here"
                  onFocus={() => setDescriptionFocused(true)}
                  onBlur={() => setDescriptionFocused(false)}
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

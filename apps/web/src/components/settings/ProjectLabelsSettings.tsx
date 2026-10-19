import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { PencilIcon, PlusIcon, TagIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { PROJECT_LABEL_COLORS, sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { useProjects, useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export interface ProjectLabelsSettingsSearch {
  readonly create?: true | undefined;
}

export function validateProjectLabelsSettingsSearch(
  raw: Record<string, unknown>,
): ProjectLabelsSettingsSearch {
  return raw.create === true || raw.create === "1" || raw.create === "true" ? { create: true } : {};
}

function reportFailure(title: string, result: { readonly cause: Cause.Cause<unknown> }) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/** Repositories (Cogenly projects) on one environment, minus the scratch chat workspace. */
function useEnvironmentRepositories(environmentId: EnvironmentId | null) {
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
 * Settings → Projects. A project is a tag for chats and Work that can link
 * several repositories. Projects belong to one environment, so the page
 * follows the scope sentence's environment.
 */
export function ProjectLabelsSettings(props: ProjectLabelsSettingsSearch) {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { labels, error, isLoaded } = useEnvironmentProjectLabels(environmentId);
  const repositories = useEnvironmentRepositories(environmentId);
  const canEdit = useAtomValue(serverEnvironment.createProjectLabel.permissionAtom(environmentId));
  const [editor, setEditor] = useState<{ label: ProjectLabelWithRepositories | null } | null>(null);
  const openedCreate = useRef(false);
  useEffect(() => {
    if (!props.create || openedCreate.current || !canEdit || environmentId === null) return;
    openedCreate.current = true;
    setEditor({ label: null });
  }, [canEdit, environmentId, props.create]);
  const repositoryById = useMemo(
    () => new Map(repositories.map((repository) => [repository.id, repository] as const)),
    [repositories],
  );
  const sorted = useMemo(
    () => sortProjectLabels(labels.map((label) => ({ label }))).map((entry) => entry.label),
    [labels],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="project-tags"
        title="Projects"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={environmentId === null || !canEdit}
            title={canEdit ? undefined : "You don't have permission to change projects here."}
            onClick={() => setEditor({ label: null })}
          >
            <PlusIcon className="size-3" />
            New project
          </Button>
        }
      >
        {environmentId === null ? (
          <SettingsRow title="Choose an environment to manage its projects." />
        ) : error !== null ? (
          <SettingsRow title="Could not load projects" description={error} />
        ) : !isLoaded ? (
          <SettingsRow title="Loading projects…" />
        ) : sorted.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TagIcon />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                Tag chats and group Work by project. A project can link several repositories.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          sorted.map((label) => {
            const linked = label.repositoryIds.flatMap((id) => {
              const repository = repositoryById.get(id);
              return repository ? [repository.title] : [];
            });
            return (
              <SettingsRow
                key={label.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectColorDot color={label.color} />
                    <span className="truncate">{label.name}</span>
                  </span>
                }
                description={
                  <>
                    {label.description ? <span className="block">{label.description}</span> : null}
                    <span className="block">
                      {linked.length === 0
                        ? "No linked repositories"
                        : `Repositories: ${linked.join(", ")}`}
                    </span>
                  </>
                }
                control={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${label.name}`}
                    disabled={!canEdit}
                    onClick={() => setEditor({ label })}
                  >
                    <PencilIcon />
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Projects are context only. Tagging a chat or linking a repository never changes what an
        agent is allowed to access.
      </p>
      {editor && environmentId !== null ? (
        <ProjectLabelEditorDialog
          key={editor.label?.id ?? "new"}
          environmentId={environmentId}
          label={editor.label}
          repositories={repositories}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ProjectLabelEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories | null;
  readonly repositories: ReturnType<typeof useEnvironmentRepositories>;
  readonly onClose: () => void;
}) {
  const { environmentId, label, onClose } = props;
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState<string | undefined>(label?.color ?? "blue");
  const [description, setDescription] = useState(label?.description ?? "");
  const [repositoryIds, setRepositoryIds] = useState<ReadonlySet<ProjectId>>(
    () => new Set(label?.repositoryIds ?? []),
  );
  const [saving, setSaving] = useState(false);
  const createLabel = useAtomCommand(serverEnvironment.createProjectLabel, "create project");
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, "update project");
  const deleteLabel = useAtomCommand(serverEnvironment.deleteProjectLabel, "delete project");
  const linkRepository = useAtomCommand(
    serverEnvironment.linkProjectLabelRepository,
    "link project repository",
  );
  const unlinkRepository = useAtomCommand(
    serverEnvironment.unlinkProjectLabelRepository,
    "unlink project repository",
  );
  const trimmedName = name.trim();

  const save = async () => {
    if (trimmedName.length === 0 || saving) return;
    setSaving(true);
    try {
      let labelId: ProjectLabelId;
      const previous = new Set(label?.repositoryIds ?? []);
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
      // Links apply one by one; a failure stops there so the dialog stays open on the truth.
      for (const repositoryId of repositoryIds) {
        if (previous.has(repositoryId)) continue;
        const result = await linkRepository({ environmentId, input: { labelId, repositoryId } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) reportFailure("Could not link repository", result);
          return;
        }
      }
      for (const repositoryId of previous) {
        if (repositoryIds.has(repositoryId)) continue;
        const result = await unlinkRepository({ environmentId, input: { labelId, repositoryId } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result))
            reportFailure("Could not unlink repository", result);
          return;
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (label === null || saving) return;
    const message = `Delete ${label.name}?\nChats and Work keep their history; only this tag and its repository links go away.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setSaving(true);
    const result = await deleteLabel({ environmentId, input: { id: label.id } });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Could not delete project", result);
      return;
    }
    onClose();
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
            Tag chats and Work with a project, and link the repositories it spans.
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
                  placeholder="What belongs here. Helps suggest this project for new chats."
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Repositories</div>
                {props.repositories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No repositories on this environment yet.
                  </p>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-y-auto">
                    {props.repositories.map((repository) => (
                      <label
                        key={repository.id}
                        className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                      >
                        <Checkbox
                          checked={repositoryIds.has(repository.id)}
                          onCheckedChange={(checked) =>
                            setRepositoryIds((current) => {
                              const next = new Set(current);
                              if (checked) next.add(repository.id);
                              else next.delete(repository.id);
                              return next;
                            })
                          }
                        />
                        <ProjectFavicon project={repository} className="size-4" />
                        <span className="min-w-0 truncate">{repository.title}</span>
                      </label>
                    ))}
                  </div>
                )}
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

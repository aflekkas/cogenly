import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { requestConfirmDialog } from "../confirmDialog";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { useEnvironmentRepositories } from "./ProjectLabelEditorDialog";
import {
  repositoryFolderMove,
  scopedRepositoryKey,
  type EnvironmentProjectLabel,
} from "./projectLabels.logic";
import { ProjectColorDot } from "./ProjectTag";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";

type Repository = ReturnType<typeof useEnvironmentRepositories>[number];

/**
 * Adds a repository to one folder. A repository is in one folder at a time,
 * so each option names the folder it is in now, and taking it from another
 * folder asks first.
 */
export function ProjectRepositoryPicker(props: {
  readonly folder: EnvironmentProjectLabel;
  readonly repositories: ReadonlyArray<Repository>;
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
  readonly disabled: boolean;
}) {
  const { folder } = props;
  const environmentId: EnvironmentId = folder.environmentId;
  const link = useAtomCommand(serverEnvironment.linkProjectLabelRepository, {
    label: "add repository to project",
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.repositories.filter(
      (repository) => needle === "" || repository.title.toLowerCase().includes(needle),
    );
  }, [props.repositories, query]);
  const folderOf = (repository: Repository) =>
    props.folderByRepository.get(scopedRepositoryKey(environmentId, repository.id));

  const add = async (repository: Repository) => {
    const move = repositoryFolderMove(folder.key, folderOf(repository));
    if (busy || (move.from !== null && !move.needsConfirm)) return;
    setOpen(false);
    if (move.needsConfirm && move.from) {
      const message = `Move ${repository.title} to ${folder.label.name}?\nIt leaves ${move.from.label.name}. A repository is in one project at a time, and its Work moves with it.`;
      const confirmed =
        (await requestConfirmDialog(message)) ?? window.confirm(message.replace("\n", " "));
      if (!confirmed) return;
    }
    setBusy(true);
    const result = await link({
      environmentId,
      input: { labelId: folder.label.id, repositoryId: repository.id },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(`Could not add ${repository.title}`, result);
    }
  };

  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={(repository: Repository) => repository.title}
      isItemEqualToValue={(left, right) => left.id === right.id}
      onValueChange={(repository) => {
        if (repository) void add(repository);
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled || busy}
        render={<Button type="button" size="xs" variant="ghost-muted" />}
      >
        <PlusIcon />
        Add repository
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-72">
        <ComboboxSearchInput
          aria-label="Find a repository"
          placeholder="Find a repository"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          {props.repositories.length === 0
            ? "No repositories on this machine yet."
            : "No matching repository."}
        </ComboboxEmpty>
        <ComboboxList>
          {(repository: Repository) => {
            const current = folderOf(repository);
            const here = current?.key === folder.key;
            return (
              <ComboboxItem key={repository.id} value={repository} disabled={here}>
                <ProjectFavicon project={repository} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{repository.title}</span>
                {here ? (
                  <CheckIcon className="ml-auto" />
                ) : current ? (
                  <span className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                    <ProjectColorDot color={current.label.color} className="size-1.5" />
                    <span className="truncate">{current.label.name}</span>
                  </span>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { AnimatedHeight } from "../components/AnimatedHeight";
import { GitHubIcon } from "../components/Icons";
import { Badge } from "../components/ui/badge";
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
import { cn } from "../lib/utils";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  hasProjectSourceLink,
  parseProjectSourceLink,
  projectSourceLinkKey,
  projectSourceLinkLabel,
  sortProjectSourceLinks,
} from "./projectSourceLinks.logic";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";
import { useEnvironmentProjectLabels } from "./useProjectLabels";

/**
 * A project's linked code sources as removable chips, and a field to add a
 * GitHub owner (org or user) or one owner/repo. A linked owner is what the
 * repository picker searches on GitHub under this project.
 */
export function ProjectSourceLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly autoFocus?: boolean;
}) {
  const { environmentId, label } = props;
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelSource.permissionAtom(environmentId),
  );
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelSource.permissionAtom(environmentId),
  );
  const linkSource = useAtomCommand(serverEnvironment.linkProjectLabelSource, {
    label: "link project source",
    reportFailure: false,
  });
  const unlinkSource = useAtomCommand(serverEnvironment.unlinkProjectLabelSource, {
    label: "unlink project source",
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [linking, setLinking] = useState(false);
  // Chips on their way out fade while the server drops them.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());

  const parsed = parseProjectSourceLink(draft);
  const duplicate = parsed !== null && hasProjectSourceLink(label.sourceLinks, parsed);
  const links = sortProjectSourceLinks(label.sourceLinks);
  const hint =
    draft.trim().length === 0
      ? "An org or user lets the repository picker search its GitHub repositories."
      : parsed === null
        ? "Enter a GitHub org or user, owner/repo, or a github.com link."
        : duplicate
          ? `${projectSourceLinkLabel(parsed)} is already linked.`
          : parsed.kind === "github-owner"
            ? `Search every repository under ${parsed.owner}.`
            : `Link ${projectSourceLinkLabel(parsed)}.`;

  const submit = async () => {
    if (parsed === null || duplicate || linking || !canLink) return;
    setLinking(true);
    const result = await linkSource({ environmentId, input: { id: label.id, link: parsed } });
    setLinking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not link ${projectSourceLinkLabel(parsed)}`, result);
      }
      return;
    }
    setDraft("");
  };

  const remove = async (link: ProjectSourceLink) => {
    const key = projectSourceLinkKey(link);
    setRemoving((current) => new Set([...current, key]));
    const result = await unlinkSource({ environmentId, input: { id: label.id, link } });
    setRemoving((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(`Could not unlink ${projectSourceLinkLabel(link)}`, result);
    }
  };

  return (
    <div className="space-y-2">
      <AnimatedHeight>
        {links.length > 0 ? (
          <ul aria-label="Linked sources" className="flex flex-wrap gap-1.5 pb-0.5">
            {links.map((link) => {
              const key = projectSourceLinkKey(link);
              const text = projectSourceLinkLabel(link);
              return (
                <li
                  key={key}
                  className={cn(
                    "list-none transition-opacity duration-(--motion-duration-fast) ease-standard reveal-motion",
                    removing.has(key) && "pointer-events-none opacity-0",
                  )}
                >
                  <Badge variant="outline" size="control">
                    <GitHubIcon aria-hidden />
                    <span className="max-w-48 truncate">{text}</span>
                    <button
                      type="button"
                      aria-label={`Unlink ${text}`}
                      disabled={!canUnlink}
                      className="-me-1 flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors duration-(--motion-duration-fast) ease-standard hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void remove(link)}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : null}
      </AnimatedHeight>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          size="sm"
          aria-label="GitHub org, user, or repository"
          placeholder="spawn-partners or owner/repo"
          autoFocus={props.autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft}
          disabled={!canLink}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!canLink || linking || parsed === null || duplicate}
        >
          <GitHubIcon aria-hidden />
          Link
        </Button>
      </form>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {canLink ? hint : "You don't have permission to change projects here."}
      </p>
    </div>
  );
}

/** "Link GitHub…" from a project's menu: the same chips and field, in a dialog. */
export function ProjectSourceLinksDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly onClose: () => void;
}) {
  // The live label, so chips follow links as they land.
  const { labels } = useEnvironmentProjectLabels(props.environmentId);
  const label = labels.find((candidate) => candidate.id === props.label.id) ?? props.label;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle size="sm">Link GitHub to {label.name}</DialogTitle>
          <DialogDescription>
            Link an org or user to find its repositories from the repository picker, or link a
            single repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ProjectSourceLinks environmentId={props.environmentId} label={label} autoFocus />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

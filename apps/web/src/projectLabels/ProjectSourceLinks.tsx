import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
} from "@cogenly/contracts";
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

/** Chips for a project's linked sources, each removable; nothing when none are linked. */
export function ProjectSourceLinkChips(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
}) {
  const { environmentId, label } = props;
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelSource.permissionAtom(environmentId),
  );
  const unlinkSource = useAtomCommand(serverEnvironment.unlinkProjectLabelSource, {
    label: "unlink project source",
    reportFailure: false,
  });
  // Chips on their way out fade while the server drops them.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const links = sortProjectSourceLinks(label.sourceLinks);

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

  if (links.length === 0) return null;
  return (
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
  );
}

/**
 * The field that links a GitHub owner (org or user) or one owner/repo, with
 * a one-line hint that reads back what the draft would link. A linked owner
 * is what the repository picker searches on GitHub under this project.
 */
export function ProjectSourceLinkField(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly autoFocus?: boolean | undefined;
  /** After a link lands, for a caller that shows the field on demand. */
  readonly onLinked?: () => void;
}) {
  const { environmentId, label } = props;
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelSource.permissionAtom(environmentId),
  );
  const linkSource = useAtomCommand(serverEnvironment.linkProjectLabelSource, {
    label: "link project source",
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [linking, setLinking] = useState(false);

  const parsed = parseProjectSourceLink(draft);
  const duplicate = parsed !== null && hasProjectSourceLink(label.sourceLinks, parsed);
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
    props.onLinked?.();
  };

  return (
    <div className="space-y-2">
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

/** A project's linked sources as chips above the field that adds one. */
export function ProjectSourceLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
  readonly autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <AnimatedHeight>
        <ProjectSourceLinkChips environmentId={props.environmentId} label={props.label} />
      </AnimatedHeight>
      <ProjectSourceLinkField
        environmentId={props.environmentId}
        label={props.label}
        autoFocus={props.autoFocus}
      />
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

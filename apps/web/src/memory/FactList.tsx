import type {
  EnvironmentId,
  Fact,
  FactCreateInput,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../confirmDialog";
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
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { ProjectLabelChips, ProjectLabelPicker } from "../projectLabels/ProjectLabelPicker";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useEnvironmentQuery } from "../state/query";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  correctedFact,
  FACT_STATUS_LABEL,
  principalAgentId,
  principalLabel,
  resolveFactRefs,
  type ResolvedFactRef,
} from "./facts.logic";
import type { useFactActions } from "./useFacts";

type FactActions = ReturnType<typeof useFactActions>;

export interface FactListContext {
  readonly environmentId: EnvironmentId;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly agentName: (agentId: string) => string | undefined;
  readonly actions: FactActions;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenExternal: (href: string) => void;
}

/** Facts with their status, author, projects and sources, and the owner's decisions. */
export function FactList(props: FactListContext & { readonly facts: ReadonlyArray<Fact> }) {
  const { facts, ...context } = props;
  return (
    <ul className="divide-y divide-border/60">
      {facts.map((fact) => (
        <FactRow key={fact.id} fact={fact} context={context} />
      ))}
    </ul>
  );
}

function FactSources(props: {
  refs: ReadonlyArray<ResolvedFactRef>;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenExternal: (href: string) => void;
}) {
  if (props.refs.length === 0) return null;
  return (
    <>
      {props.refs.map((ref, index) =>
        ref.kind === "text" ? (
          // oxlint-disable-next-line react/no-array-index-key -- refs are a stable snapshot
          <span key={index}>{ref.label}</span>
        ) : (
          <Button
            // oxlint-disable-next-line react/no-array-index-key -- refs are a stable snapshot
            key={index}
            size="xs"
            variant="link"
            onClick={() =>
              ref.kind === "thread"
                ? props.onOpenThread(ref.threadId)
                : props.onOpenExternal(ref.href)
            }
          >
            {ref.label}
            {ref.kind === "external" ? <ArrowUpRightIcon /> : null}
          </Button>
        ),
      )}
    </>
  );
}

function FactRow({ fact, context }: { fact: Fact; context: FactListContext }) {
  const { actions } = context;
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = busy || !actions.canWrite;
  const active = fact.status === "proposed" || fact.status === "confirmed";
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const forget = () =>
    run(async () => {
      const message = `Forget “${fact.subject}”?\nChats and agents stop using it. Its history stays.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (confirmed) await actions.forget(fact.id);
    });
  const refs = resolveFactRefs(fact.sourceRefs);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{fact.subject}</p>
          {fact.text.trim() !== fact.subject.trim() ? (
            <p className="line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">
              {fact.text}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {fact.status === "proposed" ? (
            <>
              <Button
                size="xs"
                disabled={disabled}
                title={actions.canWrite ? undefined : "This connection cannot change memory."}
                onClick={() => void run(() => actions.confirm(fact.id))}
              >
                <CheckIcon />
                Confirm
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => void run(() => actions.forget(fact.id))}
              >
                <XIcon />
                Reject
              </Button>
            </>
          ) : null}
          {active ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Correct ${fact.subject}`}
                title="Correct"
                disabled={disabled}
                onClick={() => setEditing(true)}
              >
                <PencilIcon />
              </Button>
              {fact.status === "confirmed" ? (
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Forget ${fact.subject}`}
                  title="Forget"
                  disabled={disabled}
                  onClick={() => void forget()}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </>
          ) : fact.status === "retracted" ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  actions.create(correctedFact(fact, { ...fact, labelIds: fact.labelIds })),
                )
              }
            >
              <RotateCcwIcon />
              Remember again
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={showHistory ? "Hide history" : "Show history"}
            aria-expanded={showHistory}
            title="History"
            onClick={() => setShowHistory((open) => !open)}
          >
            <HistoryIcon />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {fact.status !== "confirmed" ? (
          <Badge size="sm" variant={fact.status === "proposed" ? "warning" : "outline"}>
            {FACT_STATUS_LABEL[fact.status]}
          </Badge>
        ) : null}
        <span>
          {principalLabel(fact.createdBy, context.agentName)} ·{" "}
          {formatRelativeTimeLabel(fact.updatedAt)}
        </span>
        {fact.agentId && principalAgentId(fact.createdBy) !== fact.agentId ? (
          <span>· for {context.agentName(fact.agentId) ?? "an agent"}</span>
        ) : null}
        {fact.labelIds.length > 0 ? (
          <ProjectLabelChips labels={context.labels} ids={fact.labelIds} />
        ) : (
          <span>· Private</span>
        )}
        {refs.length > 0 ? <span>· From</span> : null}
        <FactSources
          refs={refs}
          onOpenThread={context.onOpenThread}
          onOpenExternal={context.onOpenExternal}
        />
      </div>
      {showHistory ? <FactHistory fact={fact} context={context} /> : null}
      {editing ? (
        <FactEditorDialog
          title="Correct this fact"
          description="Saving keeps the old wording in history and uses the correction from now on."
          labels={context.labels}
          initial={fact}
          saveLabel="Save correction"
          onClose={() => setEditing(false)}
          onSave={async (edit) => {
            const saved = await actions.correct(fact.id, correctedFact(fact, edit));
            if (saved) setEditing(false);
          }}
        />
      ) : null}
    </li>
  );
}

function FactHistory({ fact, context }: { fact: Fact; context: FactListContext }) {
  const history = useEnvironmentQuery(
    agentWorkspaceRpc.factsHistory({
      environmentId: context.environmentId,
      input: { id: fact.id },
    }),
  );
  let body: ReactNode;
  if (history.error) body = <p className="text-destructive">{history.error}</p>;
  else if (!history.data) body = <p>Loading history…</p>;
  else if (history.data.history.length === 0) body = <p>No recorded changes.</p>;
  else
    body = (
      <ol className="flex flex-col gap-1.5">
        {history.data.history.toReversed().map((entry) => (
          <li key={entry.id}>
            <span className="text-foreground">{FACT_STATUS_LABEL[entry.fact.status]}</span> by{" "}
            {principalLabel(entry.who, context.agentName)} · {formatRelativeTimeLabel(entry.at)}
            {entry.fact.text !== fact.text ? (
              <span className="block truncate">“{entry.fact.text}”</span>
            ) : null}
          </li>
        ))}
      </ol>
    );
  return (
    <div className="ms-0.5 border-s border-border/70 ps-3 text-xs text-muted-foreground">
      {body}
    </div>
  );
}

export interface FactDraft {
  readonly subject: string;
  readonly text: string;
  readonly labelIds: ReadonlyArray<ProjectLabelId>;
}

/** Subject, text and projects for a new fact or a correction. */
export function FactEditorDialog(props: {
  title: string;
  description: string;
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
  initial: FactDraft | null;
  saveLabel: string;
  onClose: () => void;
  onSave: (draft: FactDraft) => Promise<void>;
}) {
  const [subject, setSubject] = useState(props.initial?.subject ?? "");
  const [text, setText] = useState(props.initial?.text ?? "");
  const [labelIds, setLabelIds] = useState<ReadonlyArray<ProjectLabelId>>(
    props.initial?.labelIds ?? [],
  );
  const [saving, setSaving] = useState(false);
  const canSave = subject.trim().length > 0 && text.trim().length > 0 && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await props.onSave({ subject: subject.trim(), text: text.trim(), labelIds });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="fact-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="fact-subject">About</Label>
                <Input
                  id="fact-subject"
                  autoFocus
                  value={subject}
                  maxLength={500}
                  placeholder="Release process"
                  onChange={(event) => setSubject(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fact-text">What to remember</Label>
                <Textarea
                  id="fact-text"
                  value={text}
                  maxLength={16000}
                  placeholder="Releases go out on Thursdays after QA signs off."
                  onChange={(event) => setText(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Projects</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <ProjectLabelChips labels={props.labels} ids={labelIds} />
                  <ProjectLabelPicker
                    labels={props.labels}
                    selectedIds={labelIds}
                    onToggle={(id, selected) =>
                      setLabelIds((current) =>
                        selected ? [...current, id] : current.filter((other) => other !== id),
                      )
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {labelIds.length > 0
                    ? "Used as context in these projects' chats and by agents allowed to read them."
                    : "Private: only you, and the agent it belongs to, can use it."}
                </p>
              </div>
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button type="submit" form="fact-editor" disabled={!canSave}>
            {props.saveLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Builds a create input from the editor; tagged facts are readable in those projects. */
export function factInputFromDraft(
  draft: FactDraft,
  extra: Pick<FactCreateInput, "sourceRefs"> & { agentId?: FactCreateInput["agentId"] },
): FactCreateInput {
  return {
    subject: draft.subject,
    text: draft.text,
    labelIds: [...draft.labelIds],
    visibility: draft.labelIds.length > 0 ? "labels" : "user",
    sourceRefs: extra.sourceRefs,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  };
}

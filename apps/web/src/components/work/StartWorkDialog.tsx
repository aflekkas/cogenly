import { OverlayPresence } from "~/components/ui/overlay-presence";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type WorkHandoffDraft,
  WorkHandoffError,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon, HammerIcon, MessageSquareDashedIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useId, useMemo, useState } from "react";
import { create } from "zustand";

import { openCommandPalette } from "~/commandPaletteBus";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useThreadKind } from "~/hooks/useThreadKind";
import { threadCapabilities } from "~/threadCapabilities";
import { randomUUID } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShells,
  waitForThreadShell,
} from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { RepositoryBadge } from "../sidebar/modes/RepositoryBadge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  describeWorkStartFailure,
  groupWorkRepositories,
  listWorkRepositories,
  NO_REPOSITORY,
  openWorkWhenArrived,
  resolveStartWorkFields,
  resolveStartWorkSubmission,
  startWorkExcerpt,
  type StartWorkEdits,
  type WorkRepositoryChoice,
  type WorkWorkspace,
} from "./work.logic";

const isWorkHandoffError = Schema.is(WorkHandoffError);

/** Where in the chat the Work starts from; absent means the whole chat. */
export interface StartWorkFrom {
  readonly messageId: MessageId;
  /** A line of the chosen message, so the dialog can say where the handoff stops. */
  readonly excerpt: string;
}

interface StartWorkRequest {
  readonly threadRef: ScopedThreadRef;
  readonly from: StartWorkFrom | null;
  readonly key: string;
}

const useRequest = create<{ request: StartWorkRequest | null }>(() => ({ request: null }));

/**
 * Opens the Start Work dialog for a chat. Any surface may call it: menu,
 * palette, keybinding, or a message's own action with `from`.
 */
export function requestStartWork(threadRef: ScopedThreadRef, from?: StartWorkFrom) {
  useRequest.setState({ request: { threadRef, from: from ?? null, key: randomUUID() } });
}

function closeStartWork() {
  useRequest.setState({ request: null });
}

/**
 * A message's "Start Work from here", or null where it does not apply: only a
 * chat hands off to Work, and only on a connection allowed to start it.
 */
export function useStartWorkFromMessage(
  threadRef: ScopedThreadRef | null,
): ((message: { readonly id: MessageId; readonly text: string }) => void) | null {
  const thread = useThreadShell(threadRef);
  const kind = useThreadKind(thread);
  const canStart = useAtomValue(
    serverEnvironment.startWork.permissionAtom(threadRef?.environmentId ?? null),
  );
  return useMemo(() => {
    if (threadRef === null || kind === null || !canStart) return null;
    if (!threadCapabilities(kind).startWork) return null;
    return (message) =>
      requestStartWork(threadRef, {
        messageId: message.id,
        excerpt: startWorkExcerpt(message.text) || "this message",
      });
  }, [canStart, kind, threadRef]);
}

export function StartWorkDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => closeStartWork, []);
  return (
    <OverlayPresence when={request}>
      {(request) => (
        <StartWorkDialog key={request.key} threadRef={request.threadRef} from={request.from} />
      )}
    </OverlayPresence>
  );
}

type ProposalState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly draft: WorkHandoffDraft }
  | { readonly status: "failed" }
  | { readonly status: "unavailable" };

function StartWorkDialog({
  threadRef,
  from,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly from: StartWorkFrom | null;
}) {
  const id = useId();
  const navigate = useNavigate();
  const { environmentId } = threadRef;
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const scratchWorkspaceRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot;
  const repositories = useMemo(
    () => listWorkRepositories(projects, environmentId, scratchWorkspaceRoot),
    [environmentId, projects, scratchWorkspaceRoot],
  );
  const threads = useThreadShells();
  const repositoryGroups = useMemo(() => {
    const activity = new Map<ProjectId, string>();
    for (const shell of threads) {
      if (shell.environmentId !== environmentId) continue;
      const latest = activity.get(shell.projectId);
      if (latest === undefined || shell.updatedAt > latest) {
        activity.set(shell.projectId, shell.updatedAt);
      }
    }
    return groupWorkRepositories(repositories, activity);
  }, [environmentId, repositories, threads]);
  const { openScratchProject } = useScratchProject();
  const canRunWithoutRepository = scratchWorkspaceRoot != null;
  const canStart = useAtomValue(serverEnvironment.startWork.permissionAtom(environmentId));
  const canPropose = useAtomValue(
    serverEnvironment.proposeWorkHandoff.permissionAtom(environmentId),
  );
  const proposeHandoff = useAtomCommand(serverEnvironment.proposeWorkHandoff, {
    reportFailure: false,
  });
  const startWork = useAtomCommand(serverEnvironment.startWork, { reportFailure: false });

  // One id per dialog: a retry after a lost response returns the same Work thread.
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [proposalResult, setProposal] = useState<ProposalState>({ status: "loading" });
  const proposal: ProposalState = canPropose ? proposalResult : { status: "unavailable" };
  const [edits, setEdits] = useState<StartWorkEdits>({});
  const [workspace, setWorkspace] = useState<WorkWorkspace>("worktree");
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const throughMessageId = from?.messageId;

  useEffect(() => {
    if (!canPropose) return;
    let cancelled = false;
    void proposeHandoff({
      environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
      },
    }).then((result) => {
      if (cancelled) return;
      setProposal(
        result._tag === "Success" ? { status: "ready", draft: result.value } : { status: "failed" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [canPropose, environmentId, proposeHandoff, threadRef.threadId, throughMessageId]);

  const fields = resolveStartWorkFields({
    edits,
    proposal: proposal.status === "ready" ? proposal.draft : null,
    repositories,
    sourceThread: thread ? { title: thread.title, projectId: thread.projectId } : null,
  });
  const submission = resolveStartWorkSubmission({ fields, workspace, modelSelection });
  const selectedRepository = repositories.find((project) => project.id === fields.projectId);
  const noRepository = fields.projectId === NO_REPOSITORY;
  const drafting = proposal.status === "loading";

  const submit = async () => {
    if (!submission.ok || !canStart || submitting) return;
    setSubmitting(true);
    setError(null);
    // "No repository" is the environment's scratch project, created on first use.
    const targetProjectId =
      submission.input.targetProjectId ?? (await openScratchProject(environmentId))?.id ?? null;
    if (targetProjectId === null) {
      setSubmitting(false);
      return;
    }
    const result = await startWork({
      environmentId,
      input: {
        commandId,
        sourceThreadId: threadRef.threadId,
        ...submission.input,
        targetProjectId,
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(false);
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      const described = describeWorkStartFailure(
        isWorkHandoffError(failure) ? failure.stage : null,
      );
      if (!described.retryWithSameCommand) setCommandId(CommandId.make(randomUUID()));
      setError(described.message);
      return;
    }
    // The Work thread lists in Work; switch now rather than when its shell arrives.
    useUiStateStore.getState().setSidebarMode("tasks");
    const workThreadRef = scopeThreadRef(environmentId, result.value.threadId);
    const opened = await openWorkWhenArrived({
      waitForThread: () => waitForThreadShell(workThreadRef),
      open: () => {
        closeStartWork();
        return navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(workThreadRef),
        });
      },
    });
    if (!opened) {
      // The same command id answers a retry with this Work thread, not a second one.
      setSubmitting(false);
      setError("Work started, but it has not reached this window yet. Open it from Work.");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeStartWork();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <div className="flex items-center gap-2">
              <HammerIcon aria-hidden className="size-4 shrink-0" />
              <DialogTitle>Start Work</DialogTitle>
            </div>
            <DialogDescription>
              {from ? (
                <>
                  Hand this chat, up to <span className="text-foreground">“{from.excerpt}”</span>,
                  to a coding session. Later messages stay out of it.
                </>
              ) : (
                "Hand this chat to a coding session."
              )}{" "}
              The session gets the scope below and a link back to this chat.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-title`}>Title</Label>
                <Input
                  nativeInput
                  id={`${id}-title`}
                  value={fields.title}
                  maxLength={200}
                  disabled={submitting}
                  onChange={(event) => {
                    const title = event.target.value;
                    setEdits((current) => ({ ...current, title }));
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`${id}-scope`}>Scope</Label>
                  <ProposalStatus proposal={proposal} />
                </div>
                <Textarea
                  id={`${id}-scope`}
                  value={fields.scopeSummary}
                  placeholder={
                    drafting
                      ? "Drafting the scope from this chat…"
                      : "What should the session do? Requirements, constraints, references."
                  }
                  disabled={submitting}
                  onChange={(event) => {
                    const scopeSummary = event.target.value;
                    setEdits((current) => ({ ...current, scopeSummary }));
                  }}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`${id}-repository`}>Repository</Label>
                  <WorkRepositorySelect
                    id={`${id}-repository`}
                    value={fields.projectId}
                    recent={repositoryGroups.recent}
                    others={repositoryGroups.others}
                    canRunWithoutRepository={canRunWithoutRepository}
                    disabled={submitting}
                    onChange={(projectId) => setEdits((current) => ({ ...current, projectId }))}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label id={`${id}-workspace`}>Workspace</Label>
                  <ToggleGroup
                    aria-labelledby={`${id}-workspace`}
                    className="w-full *:flex-1"
                    value={[noRepository ? "local" : workspace]}
                    disabled={submitting || noRepository}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "worktree" || value === "local") setWorkspace(value);
                    }}
                  >
                    <Toggle value="worktree">New worktree</Toggle>
                    <Toggle value="local">Local</Toggle>
                  </ToggleGroup>
                </div>
              </div>
              {thread ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Model</Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <StartWorkModelPicker
                      environmentId={environmentId}
                      projectId={selectedRepository?.id ?? null}
                      selection={modelSelection ?? thread.modelSelection}
                      disabled={submitting}
                      onChange={setModelSelection}
                    />
                    {modelSelection === null ? (
                      <span className="min-w-0 truncate text-muted-foreground text-xs">
                        Same as this chat
                      </span>
                    ) : (
                      <InlineButton
                        tone="muted"
                        disabled={submitting}
                        onClick={() => setModelSelection(null)}
                      >
                        Use this chat's model
                      </InlineButton>
                    )}
                  </div>
                </div>
              ) : null}
              {noRepository ? (
                <p className="text-muted-foreground text-xs">
                  Without a repository, the session runs in a folder of its own.
                </p>
              ) : null}
              {!canStart ? (
                <p className="text-muted-foreground text-xs">
                  This connection cannot start Work on this machine.
                </p>
              ) : null}
              {!submission.ok && !drafting ? (
                <p className="text-muted-foreground text-xs">{submission.reason}</p>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeStartWork}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canStart || !submission.ok || submitting}>
              {submitting ? <Spinner /> : null}
              {submitting ? "Starting…" : "Start Work"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const ADD_REPOSITORY = "add-repository";

/**
 * The start screen's repository look in a field: badge and name, recently
 * active repositories first, then "No repository" and "Add repository".
 */
function WorkRepositorySelect(props: {
  readonly id: string;
  readonly value: WorkRepositoryChoice | null;
  readonly recent: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly others: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly canRunWithoutRepository: boolean;
  readonly disabled: boolean;
  readonly onChange: (choice: WorkRepositoryChoice) => void;
}) {
  const repositories = [...props.recent, ...props.others];
  const selected = repositories.find((repository) => repository.id === props.value);
  const items: Array<{ readonly value: string; readonly label: string }> = [
    ...repositories.map((repository) => ({ value: repository.id, label: repository.title })),
    ...(props.canRunWithoutRepository ? [{ value: NO_REPOSITORY, label: "No repository" }] : []),
    { value: ADD_REPOSITORY, label: "Add repository" },
  ];
  const renderGroup = (
    label: string,
    group: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
  ) =>
    group.length > 0 ? (
      <SelectGroup>
        <SelectGroupLabel>{label}</SelectGroupLabel>
        {group.map((repository) => (
          <SelectItem key={repository.id} value={repository.id}>
            <span className="flex min-w-0 items-center gap-2">
              <RepositoryBadge name={repository.title} />
              <span className="min-w-0 truncate">{repository.title}</span>
            </span>
          </SelectItem>
        ))}
      </SelectGroup>
    ) : null;
  return (
    <Select<string>
      value={props.value}
      items={items}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === null) return;
        // An action, not a choice: the new repository shows up in this list once added.
        if (value === ADD_REPOSITORY) {
          openCommandPalette({ open: "add-project" });
          return;
        }
        props.onChange(value as WorkRepositoryChoice);
      }}
    >
      <SelectTrigger id={props.id} className="min-w-0">
        {selected ? <RepositoryBadge name={selected.title} /> : null}
        {props.value === NO_REPOSITORY ? (
          <MessageSquareDashedIcon aria-hidden className="size-3.5" />
        ) : null}
        <SelectValue placeholder="Choose a repository" />
      </SelectTrigger>
      <SelectPopup>
        {renderGroup("Recent", props.recent)}
        {renderGroup(props.recent.length > 0 ? "Other repositories" : "Repositories", props.others)}
        <SelectGroup>
          {props.canRunWithoutRepository ? (
            <SelectItem value={NO_REPOSITORY}>
              <span className="flex min-w-0 items-center gap-2">
                <MessageSquareDashedIcon aria-hidden className="size-3.5" />
                No repository
              </span>
            </SelectItem>
          ) : null}
          <SelectItem value={ADD_REPOSITORY}>
            <span className="flex min-w-0 items-center gap-2">
              <FolderPlusIcon aria-hidden className="size-3.5" />
              Add repository…
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

function ProposalStatus({ proposal }: { readonly proposal: ProposalState }) {
  if (proposal.status === "loading") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
      >
        <Spinner size="xs" />
        Drafting from chat
      </span>
    );
  }
  if (proposal.status === "failed") {
    return (
      <span role="status" className="text-muted-foreground text-xs">
        Couldn't draft a scope. Write one.
      </span>
    );
  }
  return null;
}

/** The composer's model picker over this machine's live provider catalog. */
function StartWorkModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { environmentId, projectId, selection } = props;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          projectId,
        ),
      ).filter(isProviderInstancePickerVisible),
    [providers, settings, projectId],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model),
    [settings, providers, selection.instanceId, selection.model],
  );
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      disabled={props.disabled}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      onInstanceModelChange={(instanceId, model) => {
        if (instanceId !== selection.instanceId || model !== selection.model) {
          props.onChange({ instanceId, model });
        }
      }}
    />
  );
}

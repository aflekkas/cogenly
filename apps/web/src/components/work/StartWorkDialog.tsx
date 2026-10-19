import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type WorkHandoffDraft,
  WorkHandoffError,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useId, useMemo, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "~/hooks/useSettings";
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
  waitForThreadShell,
} from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProjectFavicon } from "../ProjectFavicon";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  describeWorkStartFailure,
  listWorkRepositories,
  openWorkWhenArrived,
  resolveStartWorkFields,
  resolveStartWorkSubmission,
  type StartWorkEdits,
  type WorkWorkspace,
} from "./work.logic";

const isWorkHandoffError = Schema.is(WorkHandoffError);

const useRequest = create<{ request: { readonly threadRef: ScopedThreadRef; key: string } | null }>(
  () => ({ request: null }),
);

/** Opens the Start Work dialog for a chat. Any surface may call it: menu, palette, keybinding. */
export function requestStartWork(threadRef: ScopedThreadRef) {
  useRequest.setState({ request: { threadRef, key: randomUUID() } });
}

function closeStartWork() {
  useRequest.setState({ request: null });
}

export function StartWorkDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => closeStartWork, []);
  return request ? <StartWorkDialog key={request.key} threadRef={request.threadRef} /> : null;
}

type ProposalState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly draft: WorkHandoffDraft }
  | { readonly status: "failed" }
  | { readonly status: "unavailable" };

function StartWorkDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
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

  useEffect(() => {
    if (!canPropose) return;
    let cancelled = false;
    void proposeHandoff({ environmentId, input: { sourceThreadId: threadRef.threadId } }).then(
      (result) => {
        if (cancelled) return;
        setProposal(
          result._tag === "Success"
            ? { status: "ready", draft: result.value }
            : { status: "failed" },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canPropose, environmentId, proposeHandoff, threadRef.threadId]);

  const fields = resolveStartWorkFields({
    edits,
    proposal: proposal.status === "ready" ? proposal.draft : null,
    repositories,
    sourceThread: thread ? { title: thread.title, projectId: thread.projectId } : null,
  });
  const submission = resolveStartWorkSubmission({ fields, workspace, modelSelection });
  const selectedRepository = repositories.find((project) => project.id === fields.projectId);
  const drafting = proposal.status === "loading";

  const submit = async () => {
    if (!submission.ok || !canStart || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await startWork({
      environmentId,
      input: { commandId, sourceThreadId: threadRef.threadId, ...submission.input },
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
            <DialogTitle>Start Work</DialogTitle>
            <DialogDescription>
              Hand this chat to a coding session in a repository. The session gets the scope below
              and a link back to this chat.
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
                  <Select
                    value={fields.projectId}
                    items={repositories.map((project) => ({
                      value: project.id,
                      label: project.title,
                    }))}
                    disabled={submitting || repositories.length === 0}
                    onValueChange={(value) => {
                      if (value !== null) {
                        setEdits((current) => ({ ...current, projectId: value as ProjectId }));
                      }
                    }}
                  >
                    <SelectTrigger id={`${id}-repository`} className="min-w-0">
                      {selectedRepository ? (
                        <ProjectFavicon project={selectedRepository} className="size-3.5" />
                      ) : null}
                      <SelectValue
                        placeholder={
                          repositories.length === 0 ? "No repositories" : "Choose a repository"
                        }
                      />
                    </SelectTrigger>
                    <SelectPopup>
                      {repositories.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label id={`${id}-workspace`}>Workspace</Label>
                  <ToggleGroup
                    aria-labelledby={`${id}-workspace`}
                    className="w-full *:flex-1"
                    value={[workspace]}
                    disabled={submitting}
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
                      projectId={fields.projectId}
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
              {repositories.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Work runs in a repository. Add one on this machine first.
                </p>
              ) : null}
              {!canStart ? (
                <p className="text-muted-foreground text-xs">
                  This connection cannot start Work on this machine.
                </p>
              ) : null}
              {!submission.ok && !drafting && repositories.length > 0 ? (
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

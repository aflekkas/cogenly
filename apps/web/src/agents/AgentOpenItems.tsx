import {
  ThreadId,
  type AgentApproval,
  type Commitment,
  type CommitmentRef,
  type ProjectLabelId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  EllipsisIcon,
  LinkIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { requestConfirmDialog } from "~/confirmDialog";
import { DisclosureChevron } from "~/components/ui/disclosure";
import { cn } from "~/lib/utils";
import { ProjectLabelChips, ProjectLabelPicker } from "~/projectLabels/ProjectLabelPicker";
import { ProjectTag } from "~/projectLabels/ProjectTag";
import { useAgents, useAgentsClient } from "./agentsClient";
import { formatMessageTime } from "./agents.logic";
import {
  COMMITMENT_STATUS_LABEL,
  commitmentDueLabel,
  commitmentOwnerLabel,
  describeApproval,
  describeCommitmentHistory,
  groupCommitments,
  resolveCommitmentRef,
} from "./agentWorkspace.logic";
import type { AgentContact, AgentWorkspaceView, CommitmentHistoryView } from "./agents.types";

const APPROVAL_EYEBROW: Record<AgentApproval["actionKind"], string> = {
  start_work: "Wants to start Work",
  schedule_trigger: "Wants a new trigger",
  change_permissions: "Wants different permissions",
  vault_use: "Wants to use a vault item",
  integration_add: "Wants to connect an integration",
  integration_update: "Wants to change an integration",
};

/**
 * One pending owner decision. Approving runs exactly the described action on the
 * server; rejecting records the decision. Nothing is granted by the agent itself.
 */
export function ApprovalDecision({
  agent,
  approval,
  workspace,
}: {
  agent: AgentContact;
  approval: AgentApproval;
  workspace: Pick<AgentWorkspaceView, "labels" | "repositories">;
}) {
  const client = useAgentsClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const description = describeApproval(approval, {
    agent,
    repositoryName: (id) => workspace.repositories.find((repo) => repo.id === id)?.title,
    labelName: (id) => workspace.labels.find((label) => label.id === id)?.name,
  });
  async function decide(decision: "approve" | "reject") {
    setPending(true);
    setError(null);
    try {
      const result = await client.decideApproval(agent, approval.id, decision);
      if (result.resultThreadId) client.openWork(agent, result.resultThreadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record your decision.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-muted-foreground">
        {APPROVAL_EYEBROW[approval.actionKind]} · {formatMessageTime(approval.requestedAt)}
      </span>
      <p className="text-sm font-medium text-foreground">{description.title}</p>
      {description.details.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs whitespace-pre-wrap text-muted-foreground">
          {description.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <Button size="xs" disabled={pending || !canWrite} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || !canWrite}
          onClick={() => void decide("reject")}
        >
          Reject
        </Button>
        {approval.actionKind === "start_work" && (
          <span className="text-2xs text-muted-foreground">Opens in Work when approved.</span>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function AgentOpenItems({
  agent,
  workspace,
  onOpenChat,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onOpenChat: (messageId?: string) => void;
}) {
  const client = useAgentsClient();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const groups = groupCommitments(workspace.commitments);
  return (
    <div className="flex w-full flex-col gap-4 px-2 pt-1 pb-4">
      {agent.approvals.length > 0 && (
        <section aria-labelledby="agent-approvals" className="flex flex-col gap-2">
          <h3 id="agent-approvals" className="text-2xs font-medium text-muted-foreground">
            Waiting on your decision
          </h3>
          {agent.approvals.map((approval) => (
            <div key={approval.id} className="rounded-xl border border-warning/30 px-3 py-2.5">
              <ApprovalDecision agent={agent} approval={approval} workspace={workspace} />
            </div>
          ))}
        </section>
      )}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium text-muted-foreground">
          Open items · its own and those in your projects
        </h3>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canWrite}
          onClick={() => setAdding((value) => !value)}
        >
          <PlusIcon />
          Add item
        </Button>
      </div>
      {adding && (
        <AddCommitment agent={agent} workspace={workspace} onDone={() => setAdding(false)} />
      )}
      {workspace.error && (
        <p className="text-xs text-destructive" role="alert">
          {workspace.error}
        </p>
      )}
      {workspace.loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading open items…
        </p>
      ) : groups.length === 0 && !workspace.error ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing recorded yet. {agent.name} proposes items it finds in your conversations and
          projects for you to confirm, or add one yourself.
        </p>
      ) : null}
      {groups.map((group) =>
        group.key === "closed" ? (
          <section key={group.key} className="flex flex-col gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              className="self-start"
              aria-expanded={showClosed}
              onClick={() => setShowClosed((value) => !value)}
            >
              <DisclosureChevron open={showClosed} />
              {group.label} · {group.items.length}
            </Button>
            {showClosed &&
              group.items.map((item) => (
                <CommitmentRow
                  key={item.id}
                  agent={agent}
                  item={item}
                  workspace={workspace}
                  onOpenChat={onOpenChat}
                />
              ))}
          </section>
        ) : (
          <section key={group.key} className="flex flex-col gap-1">
            <h4 className="text-2xs font-medium text-muted-foreground">{group.label}</h4>
            {group.items.map((item) => (
              <CommitmentRow
                key={item.id}
                agent={agent}
                item={item}
                workspace={workspace}
                onOpenChat={onOpenChat}
              />
            ))}
          </section>
        ),
      )}
    </div>
  );
}

function CommitmentRow({
  agent,
  item,
  workspace,
  onOpenChat,
}: {
  agent: AgentContact;
  item: Commitment;
  workspace: AgentWorkspaceView;
  onOpenChat: (messageId?: string) => void;
}) {
  const client = useAgentsClient();
  const { agents } = useAgents();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"done" | "dismiss" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const due = commitmentDueLabel(item.dueAt);
  const agentName = (id: string) =>
    agents.find(
      (candidate) => candidate.environmentId === agent.environmentId && candidate.id === id,
    )?.name;
  const owner = commitmentOwnerLabel(item.owner, agentName);
  const labels = workspace.labels.filter((label) => item.labelIds.includes(label.id));
  const closed = item.status === "done" || item.status === "dismissed";
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
      setForm(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this item.");
    } finally {
      setPending(false);
    }
  }
  const setStatus = (
    status: Commitment["status"],
    why: string,
    evidenceRefs: CommitmentRef[] = [],
  ) => run(() => client.setCommitmentStatus(agent, { id: item.id, status, why, evidenceRefs }));
  // Dismissing keeps the item and its history; deleting removes both for good.
  const remove = async () => {
    const message = `Delete “${item.title}”?\nIt and its history are removed for good. Dismiss it instead to keep a record.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (confirmed) await run(() => client.deleteCommitment(agent, item.id));
  };
  const disabled = pending || !canWrite;
  return (
    <article
      className={cn(
        "flex flex-col gap-1.5 rounded-xl px-3 py-2 interactive hover:bg-muted/30",
        item.status === "proposed" && "border border-dashed border-border",
        closed && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("text-sm text-foreground", item.status === "done" && "line-through")}>
            {item.title}
          </span>
          {item.description.trim() && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
          )}
        </span>
        <Badge variant={item.status === "proposed" ? "outline" : "secondary"} size="sm">
          {COMMITMENT_STATUS_LABEL[item.status]}
        </Badge>
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="Item actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {!closed && item.status !== "proposed" && (
              <>
                {item.status !== "open" && (
                  <MenuItem onClick={() => void setStatus("open", "Reopened by the owner.")}>
                    Mark open
                  </MenuItem>
                )}
                {item.status !== "in_progress" && (
                  <MenuItem onClick={() => void setStatus("in_progress", "Started by the owner.")}>
                    Mark in progress
                  </MenuItem>
                )}
                {item.status !== "waiting" && (
                  <MenuItem onClick={() => void setStatus("waiting", "Waiting, set by the owner.")}>
                    Mark waiting
                  </MenuItem>
                )}
                <MenuItem onClick={() => setForm("done")}>Mark done…</MenuItem>
                <MenuItem onClick={() => setForm("dismiss")}>Dismiss…</MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem variant="destructive" onClick={() => void remove()}>
              <Trash2Icon />
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Meta icon={<UserRoundIcon className="size-3" />}>{owner}</Meta>
        {due && (
          <Meta icon={<CalendarIcon className="size-3" />}>
            <span className={cn(due.overdue && !closed && "text-destructive")}>{due.text}</span>
          </Meta>
        )}
        {item.waitingOn && (
          <Meta icon={<ClockIcon className="size-3" />}>Waiting on {item.waitingOn}</Meta>
        )}
        {labels.map((label) => (
          <ProjectTag key={label.id} name={label.name} color={label.color} />
        ))}
      </div>
      <RefList
        agent={agent}
        workspace={workspace}
        title="From"
        refs={item.sourceRefs}
        onOpenChat={onOpenChat}
      />
      <RefList
        agent={agent}
        workspace={workspace}
        title="Evidence"
        refs={item.evidenceRefs}
        onOpenChat={onOpenChat}
      />
      <Button
        size="xs"
        variant="ghost-muted"
        className="self-start"
        aria-expanded={showHistory}
        onClick={() => setShowHistory((value) => !value)}
      >
        <DisclosureChevron open={showHistory} />
        History
      </Button>
      {showHistory && (
        <client.CommitmentHistory agent={agent} commitment={item}>
          {(view) => (
            <CommitmentHistoryList
              agent={agent}
              workspace={workspace}
              view={view}
              agentName={agentName}
              onOpenChat={onOpenChat}
            />
          )}
        </client.CommitmentHistory>
      )}
      {item.status === "proposed" && (
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            disabled={disabled}
            onClick={() =>
              void run(() => client.confirmCommitment(agent, item.id, "Confirmed by the owner."))
            }
          >
            <CheckIcon />
            Confirm
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void run(() => client.dismissCommitment(agent, item.id, "Dismissed by the owner."))
            }
          >
            Dismiss
          </Button>
          <span className="text-2xs text-muted-foreground">Not tracked until you confirm.</span>
        </div>
      )}
      {closed && (
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          disabled={disabled}
          onClick={() => void setStatus("open", "Reopened by the owner.")}
        >
          Reopen
        </Button>
      )}
      {form && (
        <StatusReasonForm
          kind={form}
          pending={pending}
          onCancel={() => setForm(null)}
          onSubmit={(why, link) => {
            const evidenceRefs: CommitmentRef[] = link
              ? [{ kind: /\/pull\/\d+/.test(link) ? "pr" : "url", id: link }]
              : [];
            void setStatus(form === "done" ? "done" : "dismissed", why, evidenceRefs);
          }}
        />
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** Who changed an item, when, from what to what, why, and the evidence they gave. */
function CommitmentHistoryList({
  agent,
  workspace,
  view,
  agentName,
  onOpenChat,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  view: CommitmentHistoryView;
  agentName: (agentId: string) => string | undefined;
  onOpenChat: (messageId?: string) => void;
}) {
  if (view.error)
    return (
      <p className="text-xs text-destructive" role="alert">
        {view.error}
      </p>
    );
  if (view.history === null)
    return (
      <p className="reveal-motion text-xs text-muted-foreground" role="status">
        Loading history…
      </p>
    );
  if (view.history.length === 0)
    return <p className="reveal-motion text-xs text-muted-foreground">No changes recorded.</p>;
  return (
    <ol
      className="reveal-motion flex flex-col gap-2 border-l border-border/70 pl-3"
      aria-label="History"
    >
      {view.history.map((entry) => {
        const { who, change } = describeCommitmentHistory(entry, agentName);
        return (
          <li key={entry.id} className="flex flex-col gap-0.5">
            <span className="text-xs text-foreground">
              {change}
              <span className="text-muted-foreground">
                {" "}
                · {who} · <time dateTime={entry.at}>{formatMessageTime(entry.at)}</time>
              </span>
            </span>
            {entry.why.trim() && (
              <span className="text-xs whitespace-pre-wrap text-muted-foreground">{entry.why}</span>
            )}
            <RefList
              agent={agent}
              workspace={workspace}
              title="Evidence"
              refs={entry.evidenceRefs}
              onOpenChat={onOpenChat}
            />
          </li>
        );
      })}
    </ol>
  );
}

function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {children}
    </span>
  );
}

function RefList({
  agent,
  workspace,
  title,
  refs,
  onOpenChat,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  title: string;
  refs: ReadonlyArray<CommitmentRef>;
  onOpenChat: (messageId?: string) => void;
}) {
  const client = useAgentsClient();
  if (refs.length === 0) return null;
  const context = {
    conversationThreadId: agent.conversationThreadId,
    messageIds: new Set(agent.messages.map((message) => message.id)),
    runs: workspace.activity?.runs ?? [],
  };
  return (
    <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
      <span>{title}</span>
      {refs.map((ref) => {
        const resolved = resolveCommitmentRef(ref, context);
        if (resolved.kind === "text")
          return (
            <span key={`${ref.kind}:${ref.id}`} className="px-1">
              {resolved.label}
            </span>
          );
        return (
          <Button
            key={`${ref.kind}:${ref.id}`}
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              if (resolved.kind === "chat") onOpenChat(resolved.messageId);
              else if (resolved.kind === "thread")
                client.openWork(agent, ThreadId.make(resolved.threadId));
              else client.openExternal(resolved.href);
            }}
          >
            {resolved.kind === "external" ? <LinkIcon /> : null}
            {resolved.label}
            {resolved.kind !== "chat" ? <ArrowUpRightIcon /> : null}
          </Button>
        );
      })}
    </div>
  );
}

/** Done needs your reason (and optionally a link as evidence); dismissing records why. */
function StatusReasonForm({
  kind,
  pending,
  onSubmit,
  onCancel,
}: {
  kind: "done" | "dismiss";
  pending: boolean;
  onSubmit: (why: string, link: string | null) => void;
  onCancel: () => void;
}) {
  const [why, setWhy] = useState("");
  const [link, setLink] = useState("");
  const trimmedLink = link.trim();
  const validLink = trimmedLink === "" || /^https?:\/\/\S+$/.test(trimmedLink);
  return (
    <form
      className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (why.trim() && validLink) onSubmit(why.trim(), trimmedLink || null);
      }}
    >
      <Input
        autoFocus
        size="sm"
        required
        maxLength={2000}
        aria-label={kind === "done" ? "What finished it?" : "Why dismiss it?"}
        placeholder={
          kind === "done" ? "What finished it? e.g. Sent the proposal" : "Why dismiss it?"
        }
        value={why}
        onChange={(event) => setWhy(event.target.value)}
      />
      {kind === "done" && (
        <Input
          size="sm"
          type="url"
          aria-label="Evidence link"
          placeholder="Evidence link (optional): PR, email, doc…"
          value={link}
          onChange={(event) => setLink(event.target.value)}
        />
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={pending || !why.trim() || !validLink}>
          {kind === "done" ? "Mark done" : "Dismiss"}
        </Button>
      </div>
    </form>
  );
}

function AddCommitment({
  agent,
  workspace,
  onDone,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onDone: () => void;
}) {
  const client = useAgentsClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerKind, setOwnerKind] = useState<"user" | "agent" | "person">("user");
  const [person, setPerson] = useState("");
  const [due, setDue] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [labelIds, setLabelIds] = useState<ProjectLabelId[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim() && (ownerKind !== "person" || person.trim());
  const ownerLabels = { user: "You", agent: agent.name, person: "Someone else" };
  const field = "flex flex-col gap-1 text-xs font-medium text-muted-foreground";
  return (
    <form
      className="flex flex-col gap-2.5 rounded-xl border border-border/70 p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setPending(true);
        setError(null);
        try {
          await client.createCommitment(agent, {
            title: title.trim(),
            description: description.trim(),
            owner:
              ownerKind === "agent"
                ? { kind: "agent", agentId: agent.id }
                : ownerKind === "person"
                  ? { kind: "person", name: person.trim() }
                  : { kind: "user" },
            // A date input is a local day; keep it at local noon so it never shifts a day.
            dueAt: due ? new Date(`${due}T12:00:00`).toISOString() : null,
            reminderAt: null,
            waitingOn: waitingOn.trim() || null,
            labelIds,
            agentId: agent.id,
            sourceRefs: [],
            evidenceRefs: [],
          });
          onDone();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not add this item.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label className={field}>
        What needs doing
        <Input
          autoFocus
          size="sm"
          required
          maxLength={500}
          placeholder="Follow up with the client about the audit"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className={field}>
        Details
        <Textarea
          rows={2}
          maxLength={16000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          Owner
          <Select
            value={ownerKind}
            onValueChange={(value) => {
              if (value === "user" || value === "agent" || value === "person") setOwnerKind(value);
            }}
          >
            <SelectTrigger size="xs" aria-label="Owner">
              <SelectValue>{ownerLabels[ownerKind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(ownerLabels) as Array<keyof typeof ownerLabels>).map((key) => (
                <SelectItem key={key} value={key} label={ownerLabels[key]}>
                  {ownerLabels[key]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <label className={field}>
          Due
          <Input
            size="sm"
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
      </div>
      {ownerKind === "person" && (
        <label className={field}>
          Who
          <Input
            size="sm"
            required
            maxLength={200}
            value={person}
            onChange={(event) => setPerson(event.target.value)}
          />
        </label>
      )}
      <label className={field}>
        Waiting on (optional)
        <Input
          size="sm"
          maxLength={500}
          placeholder="Dana's reply"
          value={waitingOn}
          onChange={(event) => setWaitingOn(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Projects</span>
        <ProjectLabelChips labels={workspace.labels} ids={labelIds} />
        <ProjectLabelPicker
          onManage={client.openProjectSettings}
          labels={workspace.labels}
          selectedIds={labelIds}
          onToggle={(id, selected) =>
            setLabelIds((current) =>
              selected
                ? [...current.filter((item) => item !== id), id]
                : current.filter((item) => item !== id),
            )
          }
        >
          {labelIds.length ? "Change" : "Add project"}
        </ProjectLabelPicker>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={pending || !valid}>
          Add item
        </Button>
      </div>
    </form>
  );
}

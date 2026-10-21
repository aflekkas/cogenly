import { OverlayPresence } from "~/components/ui/overlay-presence";
import {
  ChevronLeftIcon,
  LoaderCircleIcon,
  ArrowUpRightIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useMessageMotion } from "./useMessageMotion";
import {
  agentStatusLabel,
  conversationRows,
  modelDisplayName,
  modelSwitches,
  type AgentModelStatus,
} from "./agents.logic";
import { useAgents, useAgentsClient } from "./agentsClient";
import { AgentComposer } from "./AgentComposer";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ApprovalDecision } from "./AgentOpenItems";
import { AgentDetailsSheet } from "./AgentDetailsSheet";
import { AgentStartWork } from "./AgentStartWork";
import {
  agentViewKey,
  takeAgentView,
  watchAgentView,
  type AgentDetailsSection,
  type AgentView as AgentViewIntent,
} from "./agentViewIntent";
import { countOpenCommitments } from "./agentWorkspace.logic";
import type { AgentContact, AgentModelRef, AgentRequest, AgentWorkspaceView } from "./agents.types";

/** Which Details section a view request lands on; the chat itself closes Details. */
function detailsSectionFor(view: AgentViewIntent | null): AgentDetailsSection | null {
  switch (view) {
    case "items":
      return "items";
    case "activity":
      return "activity";
    case "responsibilities":
    case "details":
      return "responsibility";
    default:
      return null;
  }
}

/**
 * An agent is its conversation. Everything else about it (responsibility, schedule,
 * tools, open items, activity) sits behind one Details affordance in a side sheet, and
 * can also be changed by telling the agent in chat.
 */
export function AgentConversation(props: {
  agent: AgentContact;
  onBack?: () => void;
  onDeleted?: (() => void) | undefined;
}) {
  const { Workspace } = useAgentsClient();
  return (
    <Workspace agent={props.agent}>
      {(workspace) => <AgentView {...props} workspace={workspace} />}
    </Workspace>
  );
}

function AgentView({
  agent,
  workspace,
  onBack,
  onDeleted,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onBack?: (() => void) | undefined;
  onDeleted?: (() => void) | undefined;
}) {
  const client = useAgentsClient();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const viewKey = agentViewKey(agent);
  // The command palette, search and the thread menu can ask for a Details section or
  // Start Work before or after this mounts.
  const [initialView] = useState(() => takeAgentView(viewKey));
  const [details, setDetails] = useState<AgentDetailsSection | null>(
    detailsSectionFor(initialView),
  );
  const [startingWork, setStartingWork] = useState(initialView === "start-work" && canWrite);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const openChat = (messageId?: string) => {
    setDetails(null);
    setFocusMessage(messageId ?? null);
  };
  const itemsCount = agent.approvals.length + countOpenCommitments(workspace.commitments);
  const status = agentStatusLabel(agent);
  const responsibility = agent.responsibility.trim().split("\n")[0] ?? "";
  useEffect(
    () =>
      watchAgentView(viewKey, (view) => {
        if (view === "start-work") {
          if (canWrite) setStartingWork(true);
          return;
        }
        const section = detailsSectionFor(view);
        setDetails(section);
        if (section === null) setFocusMessage(null);
      }),
    [viewKey, canWrite],
  );
  return (
    <section className="agent-conversation" aria-label={`Conversation with ${agent.name}`}>
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/45">
        {onBack && (
          <Button size="icon-xs" variant="ghost-muted" aria-label="Back to agents" onClick={onBack}>
            <ChevronLeftIcon />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2.5" data-panel-flip="start">
          <AgentFace
            {...avatarFaceProps(agent.avatar)}
            state={agent.requests.length ? "blocked" : agent.state}
            size={28}
          />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium tracking-tight">{agent.name}</span>
            <span className="truncate text-2xs text-muted-foreground">
              <span key={status} className="agent-morph">
                {status}
              </span>
              {responsibility && ` · ${responsibility}`}
            </span>
          </div>
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={details !== null}
          aria-haspopup="dialog"
          onClick={() => setDetails("responsibility")}
        >
          <SlidersHorizontalIcon />
          Details
          {itemsCount > 0 && (
            <span
              className="rounded-full bg-primary px-1.5 text-2xs font-medium text-primary-foreground tabular-nums"
              aria-label={`${itemsCount} open items`}
            >
              {itemsCount}
            </span>
          )}
        </Button>
      </WorkspacePageHeader>
      <ChatPane
        agent={agent}
        workspace={workspace}
        focusMessage={focusMessage}
        onShowActivity={() => setDetails("activity")}
      />
      <OverlayPresence when={details}>
        {(section) => (
          <AgentDetailsSheet
            agent={agent}
            workspace={workspace}
            section={section}
            onClose={() => setDetails(null)}
            onOpenChat={openChat}
            onStartWork={() => {
              setDetails(null);
              setStartingWork(true);
            }}
            onDeleted={onDeleted}
          />
        )}
      </OverlayPresence>
      <OverlayPresence when={startingWork}>
        {() => (
          <AgentStartWork
            agent={agent}
            workspace={workspace}
            onClose={() => setStartingWork(false)}
            onOpenItems={() => setDetails("items")}
          />
        )}
      </OverlayPresence>
    </section>
  );
}

function ChatPane({
  agent,
  workspace,
  focusMessage,
  onShowActivity,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  focusMessage: string | null;
  onShowActivity: () => void;
}) {
  const client = useAgentsClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models } = useAgents();
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelStatus = (model: AgentModelRef) =>
    client.modelStatus?.(agent, model) ?? { status: "unknown" as const, providerName: "" };
  const currentModelUnavailable = modelStatus(agent.modelSelection).status === "unavailable";
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const busy = agent.state === "thinking" || agent.state === "working";
  const lastOwner = agent.messages.findLast((message) => message.role === "user");
  const switches = modelSwitches(agent.messages, agent.modelSelection);
  const { scroll, onScroll, stopFollowing } = useMessageMotion(
    agent,
    busy,
    switches.trailing && `${switches.trailing.instanceId}:${switches.trailing.model}`,
  );
  // An open item's source message opens here; bring it into view once.
  useEffect(() => {
    if (!focusMessage) return;
    stopFollowing();
    scroll.current
      ?.querySelector(`[data-message-id="${CSS.escape(focusMessage)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focusMessage, scroll, stopFollowing]);
  useEffect(() => {
    const mark = () => {
      if (
        document.visibilityState !== "visible" ||
        !canWrite ||
        agent.unreadCount === 0 ||
        agent.hasMoreMessages === undefined
      )
        return;
      const latest = agent.messages
        .filter((message) => message.role === "assistant" && !message.streaming)
        .toSorted(
          (a, b) =>
            (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt) ||
            b.id.localeCompare(a.id),
        )[0];
      if (latest)
        void client
          .markRead(agent, latest.id)
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Could not mark messages read."),
          );
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [agent, client, canWrite]);
  async function send(outgoing: string) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await client.send(agent, outgoing);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send. Retry your message below.",
      );
    } finally {
      setSending(false);
    }
  }
  async function retry(outgoing: string) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await client.send(agent, outgoing);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry your message.");
    } finally {
      setSending(false);
    }
  }
  return (
    <>
      <div
        className="agent-message-scroll"
        ref={scroll}
        onScroll={onScroll}
        onWheel={stopFollowing}
        onTouchStart={stopFollowing}
        onTouchEnd={onScroll}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) stopFollowing();
        }}
        onKeyDown={(event) => {
          if (
            ["ArrowUp", "PageUp", "Home", "End", "PageDown", "ArrowDown", " "].includes(event.key)
          )
            stopFollowing();
        }}
      >
        <div
          className="agent-messages"
          role="log"
          aria-label="Messages"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {(agent.hasMoreMessages || agent.historyError) && client.loadEarlier && (
            <button
              className="agent-text-button"
              type="button"
              disabled={agent.loadingEarlierMessages}
              onClick={() => {
                void client.loadEarlier!(agent).catch((cause: unknown) =>
                  setError(
                    cause instanceof Error ? cause.message : "Could not load earlier messages.",
                  ),
                );
              }}
            >
              {agent.loadingEarlierMessages
                ? "Loading…"
                : agent.historyError
                  ? "Retry earlier messages"
                  : "Earlier messages"}
            </button>
          )}
          {agent.conversationError && (
            <p className="agent-error" role="alert">
              {agent.conversationError}
            </p>
          )}
          {agent.messages.length === 0 && (
            <div className="agent-conversation-empty">
              This is the start of something good.<span>Say hello to {agent.name}.</span>
            </div>
          )}
          {conversationRows(agent.messages).map(({ message, separator, grouped }) => (
            <Fragment key={message.id}>
              {switches.before.has(message.id) && (
                <ModelSwitchLine
                  name={modelDisplayName(models, switches.before.get(message.id)!)}
                />
              )}
              <div
                data-message-id={message.id}
                className="agent-message-row"
                data-owner={message.role === "user"}
                data-grouped={grouped}
              >
                {separator && (
                  <div className="agent-separator">
                    <time dateTime={message.createdAt}>{separator}</time>
                  </div>
                )}
                <div className="agent-bubble" data-owner={message.role === "user"}>
                  {message.source && (
                    <button
                      className="agent-source"
                      type="button"
                      onClick={() => client.openWork(agent, message.source!.threadId)}
                    >
                      from: {message.source.name}
                      <ArrowUpRightIcon size={11} />
                    </button>
                  )}
                  {message.role === "assistant" ? (
                    <div className="agent-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                    </div>
                  ) : (
                    message.text
                  )}
                </div>
                {message.role === "user" &&
                  (message.id === lastOwner?.id ||
                    message.delivery === "failed" ||
                    message.delivery === "interrupted") && (
                    <span
                      className="agent-delivery"
                      data-failed={
                        message.delivery === "failed" || message.delivery === "interrupted"
                      }
                      role={message.delivery === "failed" ? "alert" : undefined}
                    >
                      {message.delivery === "failed" || message.delivery === "interrupted" ? (
                        <DeliveryFailure
                          failed={message.delivery === "failed"}
                          model={message.model ?? agent.modelSelection}
                          status={modelStatus(message.model ?? agent.modelSelection)}
                          // Retry only helps once the agent is on a model that can run.
                          canRetry={!currentModelUnavailable}
                          disabled={sending || !canWrite}
                          onRetry={() => void retry(message.text)}
                          onSwitchModel={() => setPickerOpen(true)}
                        />
                      ) : message.delivery === "sending" ? (
                        "Sending…"
                      ) : message.delivery === "queued" ? (
                        "Queued"
                      ) : message.delivery === "read" ? (
                        "Read"
                      ) : (
                        "Delivered"
                      )}
                    </span>
                  )}
              </div>
            </Fragment>
          ))}
          {switches.trailing && (
            <ModelSwitchLine name={modelDisplayName(models, switches.trailing)} />
          )}
          {agent.requests.map((request) => (
            <Request key={request.id} agent={agent} request={request} />
          ))}
          {agent.approvals.map((approval) => (
            <div key={approval.id} className="agent-message-row" data-message-id={approval.id}>
              <div className="agent-bubble agent-request">
                <ApprovalDecision agent={agent} approval={approval} workspace={workspace} />
              </div>
            </div>
          ))}
          {(busy || agent.activity.length > 0) && (
            <button className="agent-working" type="button" onClick={onShowActivity}>
              {busy ? (
                <LoaderCircleIcon size={13} className="agent-spinner" />
              ) : (
                <span className="agent-work-dot" />
              )}
              <span>{busy ? "Working on your request…" : "View recent work"}</span>
              <ArrowUpRightIcon size={12} />
            </button>
          )}
        </div>
      </div>
      <footer className="agent-composer-area">
        {error && (
          <p role="alert" className="agent-error">
            {error}
          </p>
        )}
        <AgentComposer
          agent={agent}
          canWrite={canWrite}
          sending={sending}
          modelUnavailable={currentModelUnavailable}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          onSend={send}
          onError={setError}
        />
        {busy && <p className="agent-composer-hint">You can keep messaging while I work.</p>}
      </footer>
    </>
  );
}
function DeliveryFailure({
  failed,
  model,
  status,
  canRetry,
  disabled,
  onRetry,
  onSwitchModel,
}: {
  failed: boolean;
  model: AgentModelRef;
  status: AgentModelStatus;
  canRetry: boolean;
  disabled: boolean;
  onRetry: () => void;
  onSwitchModel: () => void;
}) {
  const unavailable = failed && status.status === "unavailable";
  return (
    <>
      {unavailable
        ? `${model.model} isn't available on ${status.providerName}`
        : failed
          ? `Couldn't reach ${model.model}`
          : "Interrupted"}{" "}
      —{" "}
      {canRetry ? (
        <button type="button" disabled={disabled} onClick={onRetry}>
          Retry
        </button>
      ) : (
        <button type="button" onClick={onSwitchModel}>
          Switch model
        </button>
      )}
    </>
  );
}
function ModelSwitchLine({ name }: { name: string }) {
  return (
    <p className="agent-system-line" role="status">
      Switched to {name}
    </p>
  );
}
type RequestQuestion = NonNullable<AgentRequest["questions"]>[number];
/** A question's fixed answers; multi-select questions keep every chosen value. */
function QuestionOptions({
  question,
  answer,
  onChange,
}: {
  question: RequestQuestion;
  answer: string | string[] | undefined;
  onChange: (answer: string | string[]) => void;
}) {
  const options = (question.options ?? []).map((option) => ({
    label: option.label,
    value: option.value ?? option.label,
  }));
  const labelFor = (value: string) =>
    options.find((option) => option.value === value)?.label ?? value;
  const items = options.map((option) => (
    <SelectItem key={option.value} value={option.value} label={option.label}>
      {option.label}
    </SelectItem>
  ));
  if (question.multiSelect) {
    const selected = Array.isArray(answer) ? answer : [];
    return (
      <Select multiple value={selected} onValueChange={(next) => onChange(next)}>
        <SelectTrigger size="sm" aria-label={question.text}>
          <SelectValue placeholder="Choose answers">
            {selected.length ? selected.map(labelFor).join(", ") : "Choose answers"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>{items}</SelectPopup>
      </Select>
    );
  }
  const selected = typeof answer === "string" && answer ? answer : null;
  return (
    <Select value={selected} onValueChange={(next) => next !== null && onChange(next)}>
      <SelectTrigger size="sm" aria-label={question.text}>
        <SelectValue placeholder="Choose an answer">
          {selected === null ? "Choose an answer" : labelFor(selected)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>{items}</SelectPopup>
    </Select>
  );
}
function Request({ agent, request }: { agent: AgentContact; request: AgentRequest }) {
  const client = useAgentsClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(
      request.questions?.map((question) => [question.id, question.initialAnswer ?? ""]) ?? [],
    ),
  );
  const canRespond = request.canRespond && (client.canWrite?.(agent.environmentId) ?? true);
  async function respond(response: Parameters<typeof client.respond>[2]) {
    setPending(true);
    setError(null);
    try {
      await client.respond(agent, request.id, response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not respond.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="agent-message-row" data-message-id={request.id}>
      <div className="agent-bubble agent-request">
        <span className="agent-request-eyebrow">A moment for you</span>
        <p>{request.text}</p>
        {request.kind === "approval" ? (
          <div className="agent-inline-actions">
            {(
              request.choices ?? [
                { label: "Approve", decision: "accept" },
                { label: "Deny", decision: "decline" },
              ]
            ).map((choice) => (
              <button
                type="button"
                key={choice.decision}
                disabled={pending || !canRespond}
                onClick={() => void respond(choice.decision)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void respond(answers);
            }}
          >
            {request.questions?.map((question) => (
              <div className="agent-question" key={question.id}>
                {question.text}
                {question.options && (
                  <QuestionOptions
                    question={question}
                    answer={answers[question.id]}
                    onChange={(answer) => setAnswers({ ...answers, [question.id]: answer })}
                  />
                )}
                {question.allowCustomAnswer !== false && (
                  <input
                    aria-label={question.text}
                    required={question.required !== false && !question.options?.length}
                    value={typeof answers[question.id] === "string" ? answers[question.id] : ""}
                    placeholder="Your reply…"
                    onChange={(event) =>
                      setAnswers({ ...answers, [question.id]: event.target.value })
                    }
                  />
                )}
              </div>
            ))}
            <button
              className="agent-small-button"
              type="submit"
              disabled={
                pending ||
                !canRespond ||
                !request.questions?.every(
                  (question) =>
                    question.required === false ||
                    (Array.isArray(answers[question.id])
                      ? answers[question.id]!.length > 0
                      : String(answers[question.id] ?? "").trim().length > 0),
                )
              }
            >
              Reply
            </button>
          </form>
        )}
        {!canRespond && (
          <small>This request can no longer be answered. Open the work thread for details.</small>
        )}
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

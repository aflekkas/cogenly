import { ChevronLeftIcon, LoaderCircleIcon, ArrowUpRightIcon, PlayIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace } from "~/components/agents/face";
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
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { AgentActivity } from "./AgentActivity";
import { AgentOpenItems, ApprovalDecision } from "./AgentOpenItems";
import { AgentResponsibilities } from "./AgentResponsibilities";
import { AgentStartWork } from "./AgentStartWork";
import { agentViewKey, takeAgentView, watchAgentView, type AgentTab } from "./agentViewIntent";
import { countOpenCommitments } from "./agentWorkspace.logic";
import type { AgentContact, AgentModelRef, AgentRequest, AgentWorkspaceView } from "./agents.types";

const TABS: ReadonlyArray<{ value: AgentTab; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "activity", label: "Activity" },
  { value: "items", label: "Open items" },
  { value: "responsibilities", label: "Responsibilities" },
];

/**
 * An agent opens on its conversation. Activity, Open items and Responsibilities are
 * secondary tabs in the same view; there is no separate dashboard.
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
  // The command palette and search can ask for a tab or Start Work before or after this mounts.
  const [initialView] = useState(() => takeAgentView(viewKey));
  const [tab, setTab] = useState<AgentTab>(
    initialView && initialView !== "start-work" ? initialView : "chat",
  );
  const [startingWork, setStartingWork] = useState(initialView === "start-work" && canWrite);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const openChat = (messageId?: string) => {
    setTab("chat");
    setFocusMessage(messageId ?? null);
  };
  const itemsCount = agent.approvals.length + countOpenCommitments(workspace.commitments);
  useEffect(
    () =>
      watchAgentView(viewKey, (view) => {
        if (view === "start-work") {
          if (canWrite) setStartingWork(true);
          return;
        }
        setTab(view);
        setFocusMessage(null);
      }),
    [viewKey, canWrite],
  );
  return (
    <section className="agent-conversation" aria-label={`Conversation with ${agent.name}`}>
      <header className="agent-contact-header">
        {onBack && (
          <button
            type="button"
            className="agent-icon-button agent-back"
            aria-label="Back to agents"
            onClick={onBack}
          >
            <ChevronLeftIcon size={20} />
          </button>
        )}
        <button
          type="button"
          className="agent-header-person"
          aria-label={`${agent.name}'s responsibilities`}
          onClick={() => setTab("responsibilities")}
        >
          <AgentFace
            seed={agent.avatar.seed}
            {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
            state={agent.requests.length ? "blocked" : agent.state}
            size={56}
          />
          <span>{agent.name}</span>
          <small>{agentStatusLabel(agent)}</small>
        </button>
        <div className="agent-header-more">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canWrite}
            onClick={() => setStartingWork(true)}
          >
            <PlayIcon />
            Start Work
          </Button>
        </div>
        <ToggleGroup
          aria-label={`${agent.name} views`}
          className="max-w-full overflow-x-auto"
          value={[tab]}
          onValueChange={(value) => {
            const next = TABS.find((candidate) => candidate.value === value[0]);
            if (!next) return;
            setTab(next.value);
            setFocusMessage(null);
          }}
        >
          {TABS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
              {option.value === "items" && itemsCount > 0 && (
                <span className="tabular-nums text-muted-foreground">{itemsCount}</span>
              )}
            </Toggle>
          ))}
        </ToggleGroup>
      </header>
      {tab !== "chat" && (
        <div className="agent-message-scroll">
          {tab === "activity" ? (
            <AgentActivity
              agent={agent}
              workspace={workspace}
              onOpenChat={() => openChat()}
              onOpenItems={() => setTab("items")}
            />
          ) : tab === "items" ? (
            <AgentOpenItems agent={agent} workspace={workspace} onOpenChat={openChat} />
          ) : (
            <AgentResponsibilities agent={agent} workspace={workspace} onDeleted={onDeleted} />
          )}
        </div>
      )}
      {tab === "chat" && (
        <ChatPane
          agent={agent}
          workspace={workspace}
          focusMessage={focusMessage}
          onShowActivity={() => setTab("activity")}
        />
      )}
      {startingWork && (
        <AgentStartWork
          agent={agent}
          workspace={workspace}
          onClose={() => setStartingWork(false)}
          onOpenItems={() => setTab("items")}
        />
      )}
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
          {conversationRows(agent.messages).map(({ message, separator, grouped, endsRun }) => (
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
                {endsRun && message.runId && client.MessageContext && (
                  <client.MessageContext agent={agent} runId={message.runId} />
                )}
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
              <label className="agent-question" key={question.id}>
                {question.text}
                {question.options && (
                  <select
                    aria-label={question.text}
                    multiple={question.multiSelect}
                    value={
                      question.multiSelect
                        ? Array.isArray(answers[question.id])
                          ? answers[question.id]
                          : []
                        : typeof answers[question.id] === "string"
                          ? answers[question.id]
                          : ""
                    }
                    onChange={(event) =>
                      setAnswers({
                        ...answers,
                        [question.id]: question.multiSelect
                          ? Array.from(event.target.selectedOptions, (option) => option.value)
                          : event.target.value,
                      })
                    }
                  >
                    <option value="" disabled>
                      Choose an answer
                    </option>
                    {question.options.map((option) => (
                      <option key={option.label} value={option.value ?? option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
                {question.allowCustomAnswer !== false && (
                  <input
                    required={question.required !== false && !question.options?.length}
                    value={typeof answers[question.id] === "string" ? answers[question.id] : ""}
                    placeholder="Your reply…"
                    onChange={(event) =>
                      setAnswers({ ...answers, [question.id]: event.target.value })
                    }
                  />
                )}
              </label>
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

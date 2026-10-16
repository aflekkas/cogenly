import { ChevronLeftIcon, EllipsisIcon, LoaderCircleIcon, ArrowUpRightIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace } from "~/components/agents/face";
import { useMessageMotion } from "./useMessageMotion";
import {
  conversationRows,
  modelDisplayName,
  modelSwitches,
  type AgentModelStatus,
} from "./agents.logic";
import { useAgents, useAgentsClient } from "./agentsClient";
import { AgentComposer } from "./AgentComposer";
import { AgentDetails } from "./AgentDetails";
import type { AgentContact, AgentModelRef, AgentRequest } from "./agents.types";

export function AgentConversation({ agent, onBack }: { agent: AgentContact; onBack?: () => void }) {
  const client = useAgentsClient();
  const [details, setDetails] = useState<"about" | "activity" | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models } = useAgents();
  const detailsAnchor = useRef<HTMLElement>(null);
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
    <section className="agent-conversation" aria-label={`Conversation with ${agent.name}`}>
      <header ref={detailsAnchor} className="agent-contact-header">
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
          aria-label={`About ${agent.name}`}
          onClick={() => setDetails("about")}
        >
          <AgentFace
            seed={agent.avatar.seed}
            {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
            state={agent.requests.length ? "blocked" : agent.state}
            size={74}
          />
          <span>{agent.name}</span>
          <small>
            {agent.requests.length
              ? "Needs you"
              : busy
                ? "Thinking…"
                : !agent.enabled
                  ? "Background work paused"
                  : "Your always-on agent"}
          </small>
        </button>
        <button
          type="button"
          className="agent-icon-button agent-header-more"
          aria-label="Agent details"
          onClick={() => setDetails("about")}
        >
          <EllipsisIcon size={21} />
        </button>
      </header>
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
          {(busy || agent.activity.length > 0) && (
            <button className="agent-working" type="button" onClick={() => setDetails("activity")}>
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
      {details && (
        <AgentDetails
          agent={agent}
          anchor={detailsAnchor}
          initialTab={details}
          onClose={() => setDetails(null)}
        />
      )}
    </section>
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

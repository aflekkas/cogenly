import {
  ArrowUpIcon,
  ChevronLeftIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace } from "~/components/agents/face";
import { conversationRows } from "./agents.logic";
import { markAgentRead, useAgentsClient } from "./agentsClient";
import { AgentDetails } from "./AgentDetails";
import type { AgentContact, AgentRequest } from "./agents.types";

export function AgentConversation({ agent, onBack }: { agent: AgentContact; onBack?: () => void }) {
  const client = useAgentsClient();
  const [details, setDetails] = useState<"about" | "activity" | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const busy = agent.state === "thinking" || agent.state === "working";
  const lastOwner = agent.messages.findLast((message) => message.role === "user");
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState === "visible") markAgentRead(agent);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [agent]);
  useLayoutEffect(() => {
    if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  });
  useLayoutEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "0px";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 144)}px`;
    }
  });
  async function send() {
    if (!text.trim() || sending) return;
    const outgoing = text.trim();
    setSending(true);
    setError(null);
    try {
      await client.send(agent, outgoing);
      setText((current) => (current.trim() === outgoing ? "" : current));
      atBottom.current = true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send. Your message is still here.",
      );
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }
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
          aria-label={`About ${agent.name}`}
          onClick={() => setDetails("about")}
        >
          <AgentFace
            seed={agent.avatar.seed}
            {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
            state={!agent.enabled ? "asleep" : agent.requests.length ? "blocked" : agent.state}
            size={66}
          />
          <span>{agent.name}</span>
          <small>
            {!agent.enabled
              ? "Paused"
              : agent.requests.length
                ? "Needs you"
                : busy
                  ? "Thinking…"
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
        onScroll={() => {
          const element = scroll.current;
          if (element)
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
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
            <div
              key={message.id}
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
              {message.id === lastOwner?.id && (
                <span className="agent-delivery">
                  {message.delivery === "queued"
                    ? "Queued"
                    : message.delivery === "read"
                      ? "Read"
                      : "Delivered"}
                </span>
              )}
            </div>
          ))}
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
        <form
          className="agent-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={textarea}
            disabled={!canWrite}
            aria-label={`Message ${agent.name}`}
            placeholder={`Message ${agent.name}…`}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !window.matchMedia("(pointer: coarse)").matches
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            aria-label="Send message"
            disabled={!text.trim() || sending || !canWrite}
          >
            {sending ? (
              <LoaderCircleIcon size={18} className="agent-spinner" />
            ) : (
              <ArrowUpIcon size={19} strokeWidth={2.6} />
            )}
          </button>
        </form>
        {busy && <p className="agent-composer-hint">You can keep messaging while I work.</p>}
      </footer>
      {details && (
        <AgentDetails agent={agent} initialTab={details} onClose={() => setDetails(null)} />
      )}
    </section>
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
    <div className="agent-message-row">
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

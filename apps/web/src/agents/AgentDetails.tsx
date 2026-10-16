import { randomUUID } from "~/lib/utils";
import { ArrowUpRightIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AgentFace } from "~/components/agents/face";
import { AgentCreatedWithoutTriggerError, useAgents, useAgentsClient } from "./agentsClient";
import { formatMessageTime } from "./agents.logic";
import type { AgentContact, AgentDraft, AgentMemory, AgentTrigger } from "./agents.types";

export function AgentSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="agent-sheet surface-raised surface-raised-floating"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="agent-sheet-content">
        <div className="agent-sheet-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="agent-icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <XIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function AgentDetails({
  agent,
  onClose,
  initialTab = "about",
}: {
  agent: AgentContact;
  onClose: () => void;
  initialTab?: "about" | "activity";
}) {
  const client = useAgentsClient();
  const [tab, setTab] = useState<string>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<AgentTrigger | "new" | null>(null);
  const [newMemory, setNewMemory] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function mutate(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save changes.");
      return false;
    } finally {
      setPending(false);
    }
  }
  return (
    <AgentSheet title={`About ${agent.name}`} onClose={onClose}>
      <div className="agent-details-identity">
        <AgentFace
          seed={agent.avatar.seed}
          {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
          size={72}
          state={agent.enabled ? agent.state : "asleep"}
        />
        <h3>{agent.name}</h3>
        <span>
          {agent.enabled
            ? "Always close. Ready when you are."
            : agent.pauseReason || "Paused. Your conversation stays here."}
        </span>
      </div>
      <div className="agent-detail-tabs" role="tablist" aria-label="Agent details">
        {["about", "triggers", "memory", "activity"].map((name) => (
          <button
            type="button"
            key={name}
            role="tab"
            aria-selected={tab === name}
            aria-controls="agent-detail-panel"
            id={`agent-tab-${name}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      <div
        id="agent-detail-panel"
        role="tabpanel"
        aria-labelledby={`agent-tab-${tab}`}
        className="agent-detail-panel"
      >
        {tab === "about" && (
          <>
            <AgentForm
              initial={agent}
              environmentId={agent.environmentId}
              pending={pending}
              submitLabel="Save changes"
              onSubmit={(draft) =>
                mutate(() => client.save(agent.environmentId, { ...draft, id: agent.id }))
              }
            />
            {confirmDelete ? (
              <div className="agent-delete-confirm">
                <p>Delete {agent.name} and its triggers? Your work threads remain.</p>
                <div className="agent-inline-actions">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void mutate(async () => {
                        await client.remove(agent);
                        onClose();
                      })
                    }
                  >
                    Delete agent
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Keep agent
                  </button>
                </div>
              </div>
            ) : (
              <button className="agent-delete" type="button" onClick={() => setConfirmDelete(true)}>
                Delete agent
              </button>
            )}
          </>
        )}
        {tab === "triggers" && (
          <>
            <p className="agent-section-intro">
              A nudge to get things moving. Results come back here.
            </p>
            {agent.triggers.map((trigger) => (
              <div className="agent-detail-card" key={trigger.id}>
                <div className="agent-card-top">
                  <button
                    type="button"
                    className="agent-card-title"
                    onClick={() => setEditingTrigger(trigger)}
                  >
                    {trigger.title}
                  </button>
                  <button
                    type="button"
                    className="agent-icon-button"
                    aria-label={`Delete trigger ${trigger.title}`}
                    disabled={pending}
                    onClick={() => void mutate(() => client.deleteTrigger(agent, trigger.id))}
                  >
                    <Trash2Icon size={14} />
                  </button>
                </div>
                <span>
                  {describeTrigger(trigger)}
                  {!trigger.enabled ? " · Paused" : ""}
                </span>
                <p>{trigger.prompt}</p>
                <button
                  type="button"
                  className="agent-text-button"
                  disabled={pending || !agent.enabled}
                  onClick={() => void mutate(() => client.runTrigger(agent, trigger.id))}
                >
                  Run now
                </button>
              </div>
            ))}
            {editingTrigger ? (
              <TriggerForm
                initial={editingTrigger === "new" ? undefined : editingTrigger}
                pending={pending}
                onCancel={() => setEditingTrigger(null)}
                onSave={(trigger) =>
                  mutate(async () => {
                    await client.saveTrigger(agent, trigger);
                    setEditingTrigger(null);
                  })
                }
              />
            ) : (
              <button
                type="button"
                className="agent-add-button"
                onClick={() => setEditingTrigger("new")}
              >
                <PlusIcon size={15} />
                Add a trigger
              </button>
            )}
          </>
        )}
        {tab === "memory" && (
          <>
            <p className="agent-section-intro">
              The little things {agent.name} remembers about you.
            </p>
            {agent.memory.length === 0 && (
              <p className="agent-muted">No notes yet. Tell {agent.name} something to remember.</p>
            )}
            <form
              className="agent-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(async () => {
                  await client.saveMemory(agent, { text: newMemory.trim() });
                  setNewMemory("");
                });
              }}
            >
              <label>
                New memory note
                <textarea
                  value={newMemory}
                  maxLength={8000}
                  required
                  onChange={(event) => setNewMemory(event.target.value)}
                  placeholder="Something to remember"
                />
              </label>
              <button type="submit" disabled={pending || !newMemory.trim()}>
                Add note
              </button>
            </form>
            {agent.memory.map((note) => (
              <MemoryNote
                key={note.id}
                note={note}
                pending={pending}
                onSave={(text) => mutate(() => client.saveMemory(agent, { id: note.id, text }))}
                onDelete={() => mutate(() => client.deleteMemory(agent, note.id))}
              />
            ))}
          </>
        )}
        {tab === "activity" && (
          <>
            <p className="agent-section-intro">
              Work happens in the background. You get the highlights here.
            </p>
            {agent.activity.length === 0 && <p className="agent-muted">No background runs yet.</p>}
            {agent.activity.map((run) => (
              <button
                type="button"
                className="agent-activity-card"
                key={run.id}
                onClick={() => client.openWork(agent, run.workThreadId)}
              >
                <span className="agent-card-top">
                  <strong>
                    {agent.triggers.find((trigger) => trigger.id === run.triggerId)?.title ??
                      "Background work"}
                  </strong>
                  <ArrowUpRightIcon size={14} />
                </span>
                <span className="agent-run-status" data-status={run.status}>
                  {run.status}
                </span>
                <p>{run.summary || "Working on it…"}</p>
                <time>{formatMessageTime(run.createdAt)}</time>
              </button>
            ))}
          </>
        )}
      </div>
    </AgentSheet>
  );
}
function MemoryNote({
  note,
  pending,
  onSave,
  onDelete,
}: {
  note: AgentMemory;
  pending: boolean;
  onSave: (text: string) => Promise<boolean | undefined>;
  onDelete: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  return (
    <div className="agent-detail-card">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(text.trim()).then((saved) => {
              if (saved) setEditing(false);
            });
          }}
        >
          <textarea
            aria-label="Memory note"
            value={text}
            maxLength={8000}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="agent-inline-actions">
            <button type="submit" disabled={pending || !text.trim()}>
              Save note
            </button>
            <button
              type="button"
              onClick={() => {
                setText(note.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>{note.text}</p>
          <div className="agent-memory-footer">
            <span>
              {formatMessageTime(note.updatedAt)} · {note.source}
            </span>
            <button type="button" className="agent-text-button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="agent-icon-button"
              aria-label={`Forget ${note.text}`}
              disabled={pending}
              onClick={() => void onDelete()}
            >
              <Trash2Icon size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
export function AgentForm({
  initial,
  onSubmit,
  pending,
  submitLabel,
  children,
  environmentId,
}: {
  environmentId?: EnvironmentId;
  initial: AgentDraft;
  onSubmit: (draft: AgentDraft) => Promise<unknown>;
  pending: boolean;
  submitLabel: string;
  children?: ReactNode;
}) {
  const { models: allModels } = useAgents();
  const models = allModels.filter(
    (model) => !environmentId || !model.environmentId || model.environmentId === environmentId,
  );
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ ...draft, name: draft.name.trim() });
      }}
    >
      <div className="agent-face-picker">
        <AgentFace
          seed={draft.avatar.seed}
          {...(draft.avatar.color ? { color: draft.avatar.color } : {})}
          size={48}
        />
        <button
          type="button"
          className="agent-text-button"
          onClick={() => setDraft({ ...draft, avatar: { seed: randomUUID() } })}
        >
          <RefreshCwIcon size={13} />
          New face
        </button>
      </div>
      <label>
        Name
        <input
          value={draft.name}
          required
          maxLength={200}
          placeholder="What should we call them?"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        Instructions
        <textarea
          value={draft.instructions}
          rows={5}
          maxLength={32000}
          placeholder="What should your agent help with? How should they talk to you?"
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label>
        Model
        <select
          value={JSON.stringify(draft.modelSelection)}
          onChange={(event) => {
            const option = models.find(
              (model) => JSON.stringify(model.selection) === event.target.value,
            );
            if (option) setDraft({ ...draft, modelSelection: option.selection });
          }}
        >
          {!models.some(
            (model) => JSON.stringify(model.selection) === JSON.stringify(draft.modelSelection),
          ) && (
            <option value={JSON.stringify(draft.modelSelection)}>
              {draft.modelSelection.model}
            </option>
          )}
          {models.map((model) => (
            <option key={JSON.stringify(model.selection)} value={JSON.stringify(model.selection)}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-toggle-row">
        <span>
          Enabled<small>Allow background work</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
      </label>
      <label className="agent-cap-row">
        Daily run cap
        <input
          type="number"
          required
          min={1}
          max={1000}
          value={draft.dailyRunCap}
          onChange={(event) => setDraft({ ...draft, dailyRunCap: event.target.valueAsNumber })}
        />
      </label>
      {children}
      <button
        className="agent-primary-button"
        type="submit"
        disabled={pending || !draft.name.trim()}
      >
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
function describeTrigger(trigger: AgentTrigger) {
  const schedule = trigger.schedule;
  return schedule.type === "interval"
    ? `Every ${schedule.everyMs / 60_000} minutes`
    : schedule.type === "fixed_time"
      ? `At ${schedule.timeOfDay}${schedule.weekdays?.length ? " on selected days" : " every day"}`
      : "On webhook request";
}
export function TriggerForm({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: AgentTrigger | undefined;
  pending: boolean;
  onSave: (trigger: Omit<AgentTrigger, "id"> & { id?: string }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [schedule, setSchedule] = useState<AgentTrigger["schedule"]>(
    initial?.schedule ?? { type: "interval", everyMs: 3_600_000 },
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  return (
    <form
      className="agent-form agent-trigger-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          ...(initial ? { id: initial.id } : {}),
          title: title.trim(),
          prompt: prompt.trim(),
          schedule,
          enabled,
        });
      }}
    >
      <label>
        Trigger name
        <input
          required
          maxLength={200}
          placeholder="Nightly audit"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        What to do
        <textarea
          required
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Check the project and send me the highlights."
        />
      </label>
      <label>
        When
        <select
          value={schedule.type}
          onChange={(event) =>
            setSchedule(
              event.target.value === "interval"
                ? { type: "interval", everyMs: 3_600_000 }
                : event.target.value === "fixed_time"
                  ? { type: "fixed_time", timeOfDay: "09:00" }
                  : { type: "webhook", signature: null },
            )
          }
        >
          <option value="interval">On an interval</option>
          <option value="fixed_time">At a fixed time</option>
          <option value="webhook">On a webhook request</option>
        </select>
      </label>
      {schedule.type === "interval" && (
        <label>
          Every (minutes)
          <input
            type="number"
            required
            min={1}
            step={1}
            value={schedule.everyMs / 60_000}
            onChange={(event) =>
              setSchedule({ ...schedule, everyMs: event.target.valueAsNumber * 60_000 })
            }
          />
        </label>
      )}
      {schedule.type === "fixed_time" && (
        <>
          <label>
            Local time
            <input
              type="time"
              required
              value={schedule.timeOfDay}
              onChange={(event) => setSchedule({ ...schedule, timeOfDay: event.target.value })}
            />
          </label>
          <fieldset className="agent-weekdays">
            <legend>Days (none means every day)</legend>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={schedule.weekdays?.includes(index) ?? false}
                  onChange={(event) => {
                    const weekdays = new Set(schedule.weekdays);
                    if (event.target.checked) weekdays.add(index);
                    else weekdays.delete(index);
                    setSchedule({ ...schedule, weekdays: [...weekdays].sort() });
                  }}
                />
                {day}
              </label>
            ))}
          </fieldset>
        </>
      )}
      {schedule.type === "webhook" && (
        <p className="agent-muted">
          Uses a private webhook URL. Manage its URL, signing secret, and delivery history in
          Scheduled tasks settings after saving.
        </p>
      )}
      <label className="agent-toggle-row">
        Enabled
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <div className="agent-inline-actions">
        <button type="submit" disabled={pending || !title.trim() || !prompt.trim()}>
          Save trigger
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
const EMPTY_WORKSPACES: ReadonlyArray<{ id: NonNullable<AgentDraft["projectId"]>; title: string }> =
  [];

export function CreateAgent({
  environmentId,
  projectId,
  workspaces = EMPTY_WORKSPACES,
  onClose,
  onCreated,
}: {
  environmentId: EnvironmentId;
  projectId: AgentDraft["projectId"];
  workspaces?: ReadonlyArray<{ id: NonNullable<AgentDraft["projectId"]>; title: string }>;
  onClose: () => void;
  onCreated: (agent: AgentContact) => void;
}) {
  const client = useAgentsClient();
  const { models } = useAgents();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<Omit<AgentTrigger, "id"> | undefined>();
  const [addTrigger, setAddTrigger] = useState(false);
  const [createdAgent, setCreatedAgent] = useState<AgentContact | null>(null);
  const [workspaceId, setWorkspaceId] = useState(projectId);
  // An environment without a configured model cannot create an agent.
  const model = models.find(
    (option) => !option.environmentId || option.environmentId === environmentId,
  )?.selection;
  return (
    <AgentSheet title="Someone in your corner" onClose={onClose}>
      <p className="agent-section-intro">
        Give your agent a name and a little direction. You can figure out the rest together.
      </p>
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      {model ? (
        <>
          <AgentForm
            environmentId={environmentId}
            initial={{
              name: "",
              instructions: "",
              avatar: { seed: randomUUID() },
              modelSelection: model,
              runtimeMode: "approval-required",
              projectId,
              enabled: true,
              dailyRunCap: 24,
            }}
            pending={pending}
            submitLabel={createdAgent ? "Save agent & trigger" : "Create agent"}
            onSubmit={async (draft) => {
              setPending(true);
              setError(null);
              try {
                const agent = await client.save(
                  environmentId,
                  {
                    ...draft,
                    projectId: workspaceId,
                    ...(createdAgent ? { id: createdAgent.id } : {}),
                  },
                  trigger,
                );
                onCreated(agent);
                onClose();
              } catch (cause) {
                if (cause instanceof AgentCreatedWithoutTriggerError) setCreatedAgent(cause.agent);
                setError(cause instanceof Error ? cause.message : "Could not create agent.");
              } finally {
                setPending(false);
              }
            }}
          >
            {workspaces.length > 0 && (
              <label>
                Workspace
                <select
                  required
                  value={workspaceId ?? ""}
                  disabled={createdAgent !== null}
                  onChange={(event) =>
                    setWorkspaceId(
                      workspaces.find((workspace) => workspace.id === event.target.value)?.id ??
                        null,
                    )
                  }
                >
                  <option value="" disabled>
                    Choose a workspace
                  </option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="agent-first-trigger">
              <span>
                {trigger ? `First trigger: ${trigger.title}` : "First trigger · optional"}
              </span>
              <button
                className="agent-text-button"
                type="button"
                onClick={() => setAddTrigger(true)}
              >
                {trigger ? "Change" : "Add"}
              </button>
              {trigger && (
                <button
                  className="agent-text-button"
                  type="button"
                  onClick={() => setTrigger(undefined)}
                >
                  Remove
                </button>
              )}
            </div>
          </AgentForm>
          {addTrigger && (
            <AgentSheet title="First trigger" onClose={() => setAddTrigger(false)}>
              <TriggerForm
                pending={false}
                onCancel={() => setAddTrigger(false)}
                onSave={async (value) => {
                  setTrigger(value);
                  setAddTrigger(false);
                }}
              />
            </AgentSheet>
          )}
        </>
      ) : (
        <p className="agent-muted">
          Connect a Claude or Codex provider in Settings to create an agent.
        </p>
      )}
    </AgentSheet>
  );
}

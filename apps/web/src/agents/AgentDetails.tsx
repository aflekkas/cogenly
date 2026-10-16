import { cn, randomUUID } from "~/lib/utils";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BookmarkIcon,
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleXIcon,
  GaugeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AgentFace } from "~/components/agents/face";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { ThreadDetailsSection, ThreadDetailsSurface } from "~/components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { AgentCreatedWithoutTriggerError, useAgents, useAgentsClient } from "./agentsClient";
import { agentDraft, formatMessageTime, modelDisplayName, sameModel } from "./agents.logic";
import type { AgentContact, AgentDraft, AgentTrigger } from "./agents.types";

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
type ProfilePatch = Partial<Omit<AgentDraft, "id">>;

/** One details row: a muted icon, a label, and an optional trailing value or control. */
function DetailRow({
  icon: Icon,
  label,
  value,
  detail,
  trailing,
  ...props
}: Omit<ComponentProps<typeof ThreadDetailsControl>, "children"> & {
  icon: LucideIcon;
  label: ReactNode;
  value?: ReactNode;
  /** A second muted line; the row grows to fit it. */
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <ThreadDetailsControl multiline={detail !== undefined} {...props}>
      <Icon
        className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, detail !== undefined && "self-start mt-1.5")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-1">
        <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {label}
          {value !== undefined && <span className="text-muted-foreground"> · {value}</span>}
        </span>
        {detail !== undefined && (
          <span className="line-clamp-2 whitespace-normal text-xs font-normal text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      {trailing}
    </ThreadDetailsControl>
  );
}
const chevron = <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />;

/** The agent's profile, triggers, memory and activity in the thread details card. */
export function AgentDetails({
  agent,
  anchor,
  onClose,
  initialTab = "about",
}: {
  agent: AgentContact;
  anchor: RefObject<Element | null>;
  onClose: () => void;
  initialTab?: "about" | "activity";
}) {
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverPopup
        anchor={anchor}
        align="end"
        side="bottom"
        variant="panel"
        padding="none"
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
        aria-label={`About ${agent.name}`}
      >
        <ThreadDetailsSurface floating data-agent-details>
          <AgentDetailsContent agent={agent} onClose={onClose} initialTab={initialTab} />
        </ThreadDetailsSurface>
      </PopoverPopup>
    </Popover>
  );
}

function AgentDetailsContent({
  agent,
  onClose,
  initialTab,
}: {
  agent: AgentContact;
  onClose: () => void;
  initialTab: "about" | "activity";
}) {
  const client = useAgentsClient();
  const { models: allModels } = useAgents();
  const models = allModels.filter(
    (model) => !model.environmentId || model.environmentId === agent.environmentId,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<
    | { kind: "name" | "instructions" | "memory:new" | "trigger:new" | "delete" }
    | { kind: "memory" | "trigger"; id: string }
    | null
  >(null);
  const activity = useRef<HTMLElement>(null);
  useEffect(() => {
    if (initialTab === "activity") activity.current?.scrollIntoView({ block: "start" });
  }, [initialTab]);
  async function mutate(action: () => Promise<unknown>) {
    if (pending) return false;
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
  const saveProfile = (patch: ProfilePatch) =>
    mutate(() => client.save(agent.environmentId, { ...agentDraft(agent), ...patch }));
  const close = () => setEditing(null);
  const isEditing = (kind: string, id?: string) =>
    editing?.kind === kind && (id === undefined || ("id" in editing && editing.id === id));
  return (
    <>
      <ThreadDetailsSection
        headingId="agent-details-profile"
        title="Profile"
        separated={false}
        showHeading={false}
      >
        <div className="flex items-center gap-3 px-2.5 pt-1.5 pb-2">
          <AgentFace
            seed={agent.avatar.seed}
            {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
            size={40}
            state={agent.enabled ? agent.state : "asleep"}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {agent.enabled
                ? "Always close. Ready when you are."
                : agent.pauseReason || "Paused. Your conversation stays here."}
            </span>
          </span>
          <ThreadDetailsControl
            part="icon"
            aria-label="New face"
            title="New face"
            disabled={pending}
            onClick={() => void saveProfile({ avatar: { seed: randomUUID() } })}
          >
            <RefreshCwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </ThreadDetailsControl>
        </div>
        <div className="flex flex-col">
          {isEditing("name") ? (
            <InlineEditor
              label="Name"
              initial={agent.name}
              maxLength={200}
              pending={pending}
              onCancel={close}
              onSave={async (name) => (await saveProfile({ name })) && close()}
            />
          ) : (
            <DetailRow
              icon={UserRoundIcon}
              label="Name"
              value={agent.name}
              onClick={() => setEditing({ kind: "name" })}
            />
          )}
          {isEditing("instructions") ? (
            <InlineEditor
              label="Instructions"
              multiline
              allowEmpty
              initial={agent.instructions}
              maxLength={32000}
              placeholder="What should your agent help with? How should they talk to you?"
              pending={pending}
              onCancel={close}
              onSave={async (instructions) => (await saveProfile({ instructions })) && close()}
            />
          ) : (
            <DetailRow
              icon={ScrollTextIcon}
              label="Instructions"
              detail={agent.instructions.trim() || "Add standing instructions"}
              onClick={() => setEditing({ kind: "instructions" })}
            />
          )}
          <Menu>
            <MenuTrigger
              render={
                <DetailRow
                  icon={BotIcon}
                  label="Model"
                  value={modelDisplayName(models, agent.modelSelection)}
                  trailing={chevron}
                  disabled={pending}
                />
              }
            />
            <MenuPopup align="start">
              <MenuRadioGroup
                value={`${agent.modelSelection.instanceId}\0${agent.modelSelection.model}`}
                onValueChange={(value) => {
                  const option = models.find(
                    (model) => `${model.selection.instanceId}\0${model.selection.model}` === value,
                  );
                  if (option && !sameModel(option.selection, agent.modelSelection))
                    void saveProfile({ modelSelection: option.selection });
                }}
              >
                {models.map((model) => (
                  <MenuRadioItem
                    key={`${model.selection.instanceId}\0${model.selection.model}`}
                    value={`${model.selection.instanceId}\0${model.selection.model}`}
                  >
                    {model.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <DailyCapRow
            cap={agent.dailyRunCap}
            pending={pending}
            onSave={(dailyRunCap) => saveProfile({ dailyRunCap })}
          />
          <ThreadDetailsControl render={<label />} className="cursor-pointer">
            <PowerIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              Background work
            </span>
            <Switch
              size="sm"
              checked={agent.enabled}
              disabled={pending}
              onCheckedChange={(enabled) => void saveProfile({ enabled })}
            />
          </ThreadDetailsControl>
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="agent-details-triggers"
        title="Triggers"
        actions={
          <ThreadDetailsControl
            part="icon"
            aria-label="Add a trigger"
            onClick={() => setEditing({ kind: "trigger:new" })}
          >
            <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </ThreadDetailsControl>
        }
      >
        <div className="flex flex-col">
          {agent.triggers.length === 0 && !isEditing("trigger:new") && (
            <DetailRow
              icon={ZapIcon}
              label="Add a trigger"
              tone="muted"
              onClick={() => setEditing({ kind: "trigger:new" })}
            />
          )}
          {agent.triggers.map((trigger) =>
            isEditing("trigger", trigger.id) ? (
              <TriggerForm
                key={trigger.id}
                initial={trigger}
                pending={pending}
                onCancel={close}
                onSave={(value) =>
                  mutate(async () => {
                    await client.saveTrigger(agent, value);
                    close();
                  })
                }
              />
            ) : (
              <div key={trigger.id} className="flex items-center">
                <DetailRow
                  icon={ZapIcon}
                  label={trigger.title}
                  detail={`${describeTrigger(trigger)}${trigger.enabled ? "" : " · Paused"}`}
                  className="flex-1"
                  onClick={() => setEditing({ kind: "trigger", id: trigger.id })}
                />
                <ThreadDetailsControl
                  part="icon"
                  aria-label={`Run ${trigger.title} now`}
                  title="Run now"
                  disabled={pending || !agent.enabled}
                  onClick={() => void mutate(() => client.runTrigger(agent, trigger.id))}
                >
                  <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                </ThreadDetailsControl>
                <ThreadDetailsControl
                  part="icon"
                  aria-label={`Delete trigger ${trigger.title}`}
                  title="Delete"
                  disabled={pending}
                  onClick={() => void mutate(() => client.deleteTrigger(agent, trigger.id))}
                >
                  <Trash2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                </ThreadDetailsControl>
              </div>
            ),
          )}
          {isEditing("trigger:new") && (
            <TriggerForm
              pending={pending}
              onCancel={close}
              onSave={(value) =>
                mutate(async () => {
                  await client.saveTrigger(agent, value);
                  close();
                })
              }
            />
          )}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="agent-details-memory"
        title="Memory"
        actions={
          <ThreadDetailsControl
            part="icon"
            aria-label="Add a memory note"
            onClick={() => setEditing({ kind: "memory:new" })}
          >
            <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </ThreadDetailsControl>
        }
      >
        <div className="flex flex-col">
          {isEditing("memory:new") && (
            <InlineEditor
              label="New memory note"
              multiline
              initial=""
              maxLength={8000}
              placeholder="Something to remember"
              saveLabel="Add note"
              pending={pending}
              onCancel={close}
              onSave={(text) =>
                mutate(async () => {
                  await client.saveMemory(agent, { text });
                  close();
                })
              }
            />
          )}
          {agent.memory.length === 0 && !isEditing("memory:new") && (
            <DetailRow
              icon={BookmarkIcon}
              label="No notes yet"
              detail={`Tell ${agent.name} something to remember.`}
              tone="muted"
              onClick={() => setEditing({ kind: "memory:new" })}
            />
          )}
          {agent.memory.map((note) =>
            isEditing("memory", note.id) ? (
              <InlineEditor
                key={note.id}
                label="Memory note"
                multiline
                initial={note.text}
                maxLength={8000}
                saveLabel="Save note"
                pending={pending}
                onCancel={close}
                onDelete={() =>
                  void mutate(async () => {
                    await client.deleteMemory(agent, note.id);
                    close();
                  })
                }
                deleteLabel={`Forget ${note.text}`}
                onSave={(text) =>
                  mutate(async () => {
                    await client.saveMemory(agent, { id: note.id, text });
                    close();
                  })
                }
              />
            ) : (
              <DetailRow
                key={note.id}
                icon={BookmarkIcon}
                label={note.text}
                detail={`${formatMessageTime(note.updatedAt)} · ${note.source}`}
                onClick={() => setEditing({ kind: "memory", id: note.id })}
              />
            ),
          )}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection ref={activity} headingId="agent-details-activity" title="Activity">
        <div className="flex flex-col">
          {agent.activity.length === 0 && (
            <DetailRow icon={ActivityIcon} label="No background runs yet" tone="muted" disabled />
          )}
          {agent.activity.map((run) => (
            <DetailRow
              key={run.id}
              icon={
                run.status === "failed"
                  ? CircleXIcon
                  : run.status === "completed"
                    ? CircleCheckIcon
                    : LoaderCircleIcon
              }
              label={
                agent.triggers.find((trigger) => trigger.id === run.triggerId)?.title ??
                "Background work"
              }
              value={formatMessageTime(run.createdAt)}
              detail={run.summary || "Working on it…"}
              trailing={<ArrowUpRightIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />}
              onClick={() => client.openWork(agent, run.workThreadId)}
            />
          ))}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-details-danger" title="Delete" showHeading={false}>
        {isEditing("delete") ? (
          <div className="flex flex-col">
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              Delete {agent.name} and its triggers? Your work threads remain.
            </p>
            <DetailRow
              icon={Trash2Icon}
              label="Delete agent"
              tone="destructive"
              disabled={pending}
              onClick={() =>
                void mutate(async () => {
                  await client.remove(agent);
                  onClose();
                })
              }
            />
            <DetailRow icon={XIcon} label="Keep agent" onClick={close} />
          </div>
        ) : (
          <DetailRow
            icon={Trash2Icon}
            label="Delete agent"
            tone="destructive"
            onClick={() => setEditing({ kind: "delete" })}
          />
        )}
      </ThreadDetailsSection>
      {error && (
        <p className="border-t border-border/65 px-4 py-2.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function DailyCapRow({
  cap,
  pending,
  onSave,
}: {
  cap: number;
  pending: boolean;
  onSave: (cap: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(cap));
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(String(cap));
      }}
    >
      <PopoverTrigger
        render={
          <DetailRow
            icon={GaugeIcon}
            label="Runs"
            value={`Daily cap ${cap}`}
            trailing={chevron}
            disabled={pending}
          />
        }
      />
      <PopoverPopup align="start" padding="compact" width="sm">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void onSave(parsed).then((saved) => saved && setOpen(false));
          }}
        >
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Background runs per day
            <Input
              type="number"
              size="sm"
              min={1}
              max={1000}
              required
              aria-label="Daily run cap"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <Button type="submit" size="xs" className="self-end" disabled={pending || !valid}>
            Save
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/** A row that expanded into an editor; Escape cancels and ⌘/Ctrl+Enter saves. */
function InlineEditor({
  label,
  initial,
  multiline = false,
  allowEmpty = false,
  maxLength,
  placeholder,
  saveLabel = "Save",
  pending,
  onSave,
  onCancel,
  onDelete,
  deleteLabel,
}: {
  label: string;
  initial: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  maxLength: number;
  placeholder?: string;
  saveLabel?: string;
  pending: boolean;
  onSave: (text: string) => unknown;
  onCancel: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  const [text, setText] = useState(initial);
  const canSave = !pending && (allowEmpty || text.trim().length > 0);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !multiline)) {
      event.preventDefault();
      if (canSave) void onSave(text.trim());
    }
  };
  return (
    <form
      className="flex flex-col gap-2 px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void onSave(text.trim());
      }}
    >
      {multiline ? (
        <Textarea
          autoFocus
          aria-label={label}
          rows={5}
          maxLength={maxLength}
          placeholder={placeholder}
          value={text}
          onKeyDown={keys}
          onChange={(event) => setText(event.target.value)}
        />
      ) : (
        <Input
          autoFocus
          size="sm"
          aria-label={label}
          maxLength={maxLength}
          placeholder={placeholder}
          value={text}
          onKeyDown={keys}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <div className="flex items-center justify-end gap-1.5">
        {onDelete && (
          <Button
            type="button"
            size="xs"
            variant="ghost-destructive"
            className="me-auto"
            aria-label={deleteLabel}
            disabled={pending}
            onClick={onDelete}
          >
            Forget
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!canSave}>
          {saveLabel}
        </Button>
      </div>
    </form>
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
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_LABELS = {
  interval: "On an interval",
  fixed_time: "At a fixed time",
  webhook: "On a webhook request",
} as const;

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
  const field = "flex flex-col gap-1.5 text-xs font-medium text-muted-foreground";
  return (
    <form
      className="flex flex-col gap-2.5 px-2.5 py-2"
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
      <label className={field}>
        Trigger name
        <Input
          autoFocus
          size="sm"
          required
          maxLength={200}
          placeholder="Nightly audit"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className={field}>
        What to do
        <Textarea
          required
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Check the project and send me the highlights."
        />
      </label>
      <div className={field}>
        When
        <Select
          value={schedule.type}
          onValueChange={(type) =>
            setSchedule(
              type === "interval"
                ? { type: "interval", everyMs: 3_600_000 }
                : type === "fixed_time"
                  ? { type: "fixed_time", timeOfDay: "09:00" }
                  : { type: "webhook", signature: null },
            )
          }
        >
          <SelectTrigger size="sm" aria-label="When">
            <SelectValue>{SCHEDULE_LABELS[schedule.type]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(SCHEDULE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value} label={label}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {schedule.type === "interval" && (
        <label className={field}>
          Every (minutes)
          <Input
            type="number"
            size="sm"
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
          <label className={field}>
            Local time
            <Input
              type="time"
              size="sm"
              required
              value={schedule.timeOfDay}
              onChange={(event) => setSchedule({ ...schedule, timeOfDay: event.target.value })}
            />
          </label>
          <fieldset className={field}>
            <legend className="mb-1.5">Days (none means every day)</legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((day, index) => {
                const checked = schedule.weekdays?.includes(index) ?? false;
                return (
                  <Toggle
                    key={day}
                    size="sm"
                    variant="outline"
                    aria-label={day}
                    pressed={checked}
                    onPressedChange={(pressed) => {
                      const weekdays = new Set(schedule.weekdays);
                      if (pressed) weekdays.add(index);
                      else weekdays.delete(index);
                      setSchedule({ ...schedule, weekdays: [...weekdays].sort() });
                    }}
                  >
                    {day}
                  </Toggle>
                );
              })}
            </div>
          </fieldset>
        </>
      )}
      {schedule.type === "webhook" && (
        <p className="text-xs text-muted-foreground">
          Uses a private webhook URL. Manage its URL, signing secret, and delivery history in
          Scheduled tasks settings after saving.
        </p>
      )}
      <label className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        Enabled
        <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
      </label>
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={pending || !title.trim() || !prompt.trim()}>
          Save trigger
        </Button>
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
        <p className="agent-muted">Connect a provider in Settings to create an agent.</p>
      )}
    </AgentSheet>
  );
}

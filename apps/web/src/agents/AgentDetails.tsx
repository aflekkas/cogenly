import { cn, randomUUID } from "~/lib/utils";
import { ChevronDownIcon, GaugeIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import { useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import {
  defaultAgentPermissions,
  type EnvironmentId,
  type ProjectId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { eventFilterChoices, triggerErrorMessage } from "./agentWorkspace.logic";
import { AgentFace } from "~/components/agents/face";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
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
import {
  AgentCreatedWithoutTriggerError,
  useAgents,
  useAgentsClient,
  useDefaultAgentModel,
} from "./agentsClient";
import { DEFAULT_EVENT_TRIGGER, EventTriggerFields } from "./EventTriggerFields";
import type { AgentContact, AgentDraft, AgentTrigger } from "./agents.types";

/** One details row: a muted icon, a label, and an optional trailing value or control. */
export function DetailRow({
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

export function DailyCapRow({
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
export function InlineEditor({
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
}: {
  initial: AgentDraft;
  onSubmit: (draft: AgentDraft) => Promise<unknown>;
  pending: boolean;
  submitLabel: string;
  children?: ReactNode;
}) {
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
        Responsibility
        <textarea
          value={draft.responsibility ?? ""}
          rows={3}
          maxLength={32000}
          placeholder="What should it own? E.g. keep track of what I owe Spawn clients and follow up."
          onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })}
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
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_LABELS = {
  interval: "On an interval",
  fixed_time: "At a fixed time",
  event: "When something happens",
  webhook: "On a webhook request",
} as const;
const NO_REPOSITORIES: ReadonlyArray<{ id: ProjectId; title: string }> = [];

export function TriggerForm({
  initial,
  pending,
  onSave,
  onCancel,
  labels = EMPTY_LABELS,
  repositories = NO_REPOSITORIES,
  onManageProjects,
}: {
  initial?: AgentTrigger | undefined;
  pending: boolean;
  onSave: (trigger: Omit<AgentTrigger, "id"> & { id?: string }) => Promise<unknown>;
  onCancel: () => void;
  /** Projects an event trigger may be limited to. */
  labels?: ReadonlyArray<ProjectLabelWithRepositories>;
  /** Repositories an event trigger may be limited to. */
  repositories?: ReadonlyArray<{ id: ProjectId; title: string }>;
  onManageProjects?: (() => void) | undefined;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [schedule, setSchedule] = useState<AgentTrigger["schedule"]>(
    initial?.schedule ?? { type: "interval", everyMs: 3_600_000 },
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "flex flex-col gap-1.5 text-xs font-medium text-muted-foreground";
  return (
    <form
      className="flex flex-col gap-2.5 px-2.5 py-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          await onSave({
            ...(initial ? { id: initial.id } : {}),
            title: title.trim(),
            prompt: prompt.trim(),
            schedule,
            enabled,
          });
        } catch (cause) {
          setError(triggerErrorMessage(cause, "Could not save this trigger."));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className={field}>
        Trigger name
        <Input
          autoFocus
          size="sm"
          required
          maxLength={200}
          placeholder={schedule.type === "event" ? "Failing checks" : "Nightly audit"}
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
          placeholder={
            schedule.type === "event"
              ? "Look at what failed and tell me only if it needs me."
              : "Check the project and send me the highlights."
          }
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
                  : type === "event"
                    ? DEFAULT_EVENT_TRIGGER
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
      {schedule.type === "event" && (
        <EventTriggerFields
          value={schedule}
          labels={labels}
          repositories={repositories}
          onManageProjects={onManageProjects}
          onChange={(value) => setSchedule({ type: "event", ...value })}
        />
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
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={pending || saving || !title.trim() || !prompt.trim()}
        >
          Save trigger
        </Button>
      </div>
    </form>
  );
}

const EMPTY_WORKSPACES: ReadonlyArray<{ id: NonNullable<AgentDraft["projectId"]>; title: string }> =
  [];
const EMPTY_LABELS: ReadonlyArray<ProjectLabelWithRepositories> = [];

/**
 * Creating an agent is always an explicit owner decision: nothing else in the app
 * creates one. New agents reach every project and start with read, draft and Start Work.
 */
export function CreateAgent({
  environmentId,
  projectId,
  workspaces = EMPTY_WORKSPACES,
  labels = EMPTY_LABELS,
  onClose,
  onCreated,
}: {
  environmentId: EnvironmentId;
  labels?: ReadonlyArray<ProjectLabelWithRepositories>;
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
  const triggerChoices = eventFilterChoices(
    { permissions: defaultAgentPermissions },
    labels,
    workspaces,
  );
  // An environment without a ready provider cannot create an agent.
  const model =
    useDefaultAgentModel(environmentId, workspaceId ?? null) ??
    models.find((option) => !option.environmentId || option.environmentId === environmentId)
      ?.selection;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Someone in your corner</DialogTitle>
          <DialogDescription>
            Give your agent a name and a little direction. You can figure out the rest together.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error && (
            <p className="agent-error" role="alert">
              {error}
            </p>
          )}
          {model ? (
            <>
              <AgentForm
                initial={{
                  name: "",
                  responsibility: "",
                  instructions: "",
                  avatar: { seed: randomUUID() },
                  modelSelection: model,
                  runtimeMode: "approval-required",
                  projectId,
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
                        modelSelection: model,
                        projectId: workspaceId,
                        ...(createdAgent ? { id: createdAgent.id } : {}),
                      },
                      trigger,
                    );
                    onCreated(agent);
                    onClose();
                  } catch (cause) {
                    if (cause instanceof AgentCreatedWithoutTriggerError)
                      setCreatedAgent(cause.agent);
                    setError(triggerErrorMessage(cause, "Could not create agent."));
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {workspaces.length > 0 && (
                  <div className="agent-form-field">
                    <span>Workspace</span>
                    <Select
                      required
                      value={workspaceId ?? null}
                      disabled={createdAgent !== null}
                      onValueChange={(value) =>
                        setWorkspaceId(
                          workspaces.find((workspace) => workspace.id === value)?.id ?? null,
                        )
                      }
                    >
                      <SelectTrigger aria-label="Workspace">
                        <SelectValue placeholder="Choose a workspace">
                          {workspaces.find((workspace) => workspace.id === workspaceId)?.title ??
                            "Choose a workspace"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {workspaces.map((workspace) => (
                          <SelectItem
                            key={workspace.id}
                            value={workspace.id}
                            label={workspace.title}
                          >
                            {workspace.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
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
              <Dialog open={addTrigger} onOpenChange={setAddTrigger}>
                <DialogPopup>
                  <DialogHeader>
                    <DialogTitle>First trigger</DialogTitle>
                  </DialogHeader>
                  <DialogPanel>
                    <TriggerForm
                      {...triggerChoices}
                      onManageProjects={client.openProjectSettings}
                      pending={false}
                      onCancel={() => setAddTrigger(false)}
                      onSave={async (value) => {
                        setTrigger(value);
                        setAddTrigger(false);
                      }}
                    />
                  </DialogPanel>
                </DialogPopup>
              </Dialog>
            </>
          ) : (
            <p className="agent-muted">Connect a provider in Settings to create an agent.</p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

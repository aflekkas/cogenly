import { cn } from "~/lib/utils";
import { ChevronDownIcon, GaugeIcon, type LucideIcon } from "lucide-react";
import { useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import type { EnvironmentId, ProjectId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { triggerErrorMessage } from "./agentWorkspace.logic";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import { Button } from "~/components/ui/button";
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
import { DEFAULT_EVENT_TRIGGER, EventTriggerFields } from "./EventTriggerFields";
import type { AgentTrigger } from "./agents.types";

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_LABELS = {
  interval: "On an interval",
  fixed_time: "At a fixed time",
  event: "When something happens",
  webhook: "On a webhook request",
} as const;
const NO_REPOSITORIES: ReadonlyArray<{ id: ProjectId; title: string }> = [];
const NO_LABELS: ReadonlyArray<ProjectLabelWithRepositories> = [];

/** The full trigger editor: every schedule kind and event filter, under Details → Schedule. */
export function TriggerForm({
  initial,
  pending,
  onSave,
  onCancel,
  environmentId,
  labels = NO_LABELS,
  repositories = NO_REPOSITORIES,
  onManageProjects,
}: {
  initial?: AgentTrigger | undefined;
  pending: boolean;
  onSave: (trigger: Omit<AgentTrigger, "id"> & { id?: string }) => Promise<unknown>;
  onCancel: () => void;
  /** The agent's environment, which `labels` belong to. */
  environmentId: EnvironmentId;
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
          environmentId={environmentId}
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

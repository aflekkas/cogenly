import { cn } from "~/lib/utils";
import {
  BellIcon,
  BookmarkIcon,
  FlagIcon,
  FolderGit2Icon,
  PlayIcon,
  PlusIcon,
  ScrollTextIcon,
  ShieldAlertIcon,
  SmileIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentAvatar, AgentPermissions } from "@t3tools/contracts";
import { PopoverTrigger } from "~/components/ui/popover";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { AgentAvatarPicker, AgentAvatarTrigger } from "./AgentAvatarPicker";
import { useAgentsClient } from "./agentsClient";
import { agentDraft, agentStatusLabel, formatMessageTime } from "./agents.logic";
import {
  EVENT_RUN_NOW_UNSUPPORTED_MESSAGE,
  PERMISSION_OPTIONS,
  agentWorkStartPolicy,
  describeSchedule,
  eventFilterChoices,
  triggerErrorMessage,
  type FilterNames,
} from "./agentWorkspace.logic";
import { DailyCapRow, DetailRow, InlineEditor, TriggerForm } from "./AgentDetails";
import type { AgentContact, AgentDraft, AgentWorkspaceView } from "./agents.types";

type ProfilePatch = Partial<Omit<AgentDraft, "id">>;
type Editing =
  | {
      kind: "name" | "instructions" | "responsibility" | "memory:new" | "trigger:new" | "delete";
    }
  | { kind: "memory" | "trigger"; id: string }
  | null;

const NOTIFY_LABEL = {
  action_required: "Only when it needs you",
  meaningful_changes: "When something meaningful changes",
  all: "After every run",
} as const;

/**
 * Everything the agent is allowed and asked to do, edited in place. Every change here
 * is the owner's own decision and saves directly; the agent can only ask for these.
 */
export function AgentResponsibilities({
  agent,
  workspace,
  onDeleted,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onDeleted?: (() => void) | undefined;
}) {
  const client = useAgentsClient();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  async function mutate(action: () => Promise<unknown>) {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(triggerErrorMessage(cause, "Could not save changes."));
      return false;
    } finally {
      setPending(false);
    }
  }
  const saveProfile = (patch: ProfilePatch) =>
    mutate(() => client.save(agent.environmentId, { ...agentDraft(agent), ...patch }));
  // Picks show at once; one save runs at a time and the latest pick waiting goes
  // next. A saved pick shows until the agent's own avatar next changes, so the
  // face doesn't flick back while the update is on its way.
  const [avatarDraft, setAvatarDraft] = useState<{
    avatar: AgentAvatar;
    until: AgentAvatar | null;
  } | null>(null);
  const queuedAvatar = useRef<AgentAvatar | null>(null);
  const savingAvatar = useRef(false);
  const storedAvatar = useRef(agent.avatar);
  useEffect(() => {
    storedAvatar.current = agent.avatar;
  }, [agent.avatar]);
  const avatar =
    avatarDraft && (avatarDraft.until === null || avatarDraft.until === agent.avatar)
      ? avatarDraft.avatar
      : agent.avatar;
  const saveAvatar = async (next: AgentAvatar) => {
    setAvatarDraft({ avatar: next, until: null });
    queuedAvatar.current = next;
    if (savingAvatar.current) return;
    savingAvatar.current = true;
    let saved = true;
    while (queuedAvatar.current) {
      const pick = queuedAvatar.current;
      queuedAvatar.current = null;
      saved = await client.save(agent.environmentId, { ...agentDraft(agent), avatar: pick }).then(
        () => true,
        (cause: unknown) => {
          setError(triggerErrorMessage(cause, "Could not save changes."));
          return false;
        },
      );
    }
    savingAvatar.current = false;
    setAvatarDraft((draft) =>
      saved && draft ? { avatar: draft.avatar, until: storedAvatar.current } : null,
    );
  };
  const close = () => setEditing(null);
  const isEditing = (kind: string, id?: string) =>
    editing?.kind === kind && (id === undefined || ("id" in editing && editing.id === id));
  const status = agentStatusLabel(agent);
  const labelsById = new Map(workspace.labels.map((label) => [label.id as string, label]));
  const workStart = agentWorkStartPolicy(agent);
  const setPermission = (key: keyof AgentPermissions, value: boolean) =>
    void saveProfile({ permissions: { ...agent.permissions, [key]: value } });
  const disabled = pending || !canWrite;
  const filterNames: FilterNames = {
    labelName: (id) => labelsById.get(id)?.name,
    repositoryName: (id) =>
      workspace.repositories.find((repository) => repository.id === id)?.title,
  };
  // Event triggers can name only what the agent can read, as the server enforces.
  const triggerFormProps = {
    ...eventFilterChoices(agent, workspace.labels, workspace.repositories),
    onManageProjects: client.openProjectSettings,
  };
  const saveTrigger = async (value: Parameters<typeof client.saveTrigger>[1]) => {
    // Errors stay in the form, where an out-of-scope filter can be fixed.
    await client.saveTrigger(agent, value);
    close();
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col pb-10">
      <ThreadDetailsSection
        headingId="agent-profile"
        title="Profile"
        separated={false}
        showHeading={false}
      >
        <AgentAvatarPicker avatar={avatar} onChange={(next) => void saveAvatar(next)}>
          <div className="flex items-center gap-3 px-2.5 pt-1.5 pb-2">
            <AgentAvatarTrigger
              avatar={avatar}
              size={40}
              state={agent.state}
              disabled={!canWrite}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{status}</span>
            </span>
            <PopoverTrigger
              disabled={!canWrite}
              render={
                <ThreadDetailsControl part="icon" aria-label="Choose face" title="Choose face" />
              }
            >
              <SmileIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            </PopoverTrigger>
          </div>
        </AgentAvatarPicker>
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
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "name" })}
          />
        )}
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-mission" title="Responsibility">
        {isEditing("responsibility") ? (
          <InlineEditor
            label="Responsibility"
            multiline
            allowEmpty
            initial={agent.responsibility}
            maxLength={32000}
            placeholder="What outcomes should it keep track of? E.g. follow up on Spawn client commitments."
            pending={pending}
            onCancel={close}
            onSave={async (responsibility) => (await saveProfile({ responsibility })) && close()}
          />
        ) : (
          <DetailRow
            icon={FlagIcon}
            label="Mission"
            detail={agent.responsibility.trim() || "Describe what it should own and keep track of"}
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "responsibility" })}
          />
        )}
        {isEditing("instructions") ? (
          <InlineEditor
            label="Instructions"
            multiline
            allowEmpty
            initial={agent.instructions}
            maxLength={32000}
            placeholder="How should it work and talk to you?"
            pending={pending}
            onCancel={close}
            onSave={async (instructions) => (await saveProfile({ instructions })) && close()}
          />
        ) : (
          <DetailRow
            icon={ScrollTextIcon}
            label="Instructions"
            detail={agent.instructions.trim() || "Add standing instructions"}
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "instructions" })}
          />
        )}
        <DetailRow
          icon={FolderGit2Icon}
          label="Home repository"
          value={
            workspace.repositories.find((repository) => repository.id === agent.projectId)?.title ??
            "None"
          }
          detail="Where its conversation runs. It can work in every repository and add new ones."
          disabled
        />
        <DailyCapRow
          cap={agent.dailyRunCap}
          pending={disabled}
          onSave={(dailyRunCap) => saveProfile({ dailyRunCap })}
        />
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-permissions" title="Permissions">
        {PERMISSION_OPTIONS.filter((option) => !option.highImpact).map((option) => (
          <PermissionRow
            key={option.key}
            label={option.label}
            description={option.description}
            checked={agent.permissions[option.key]}
            disabled={disabled}
            onChange={(value) => setPermission(option.key, value)}
          />
        ))}
        <div className="mx-1 mt-2 rounded-xl border border-warning/25 py-1">
          <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1 text-2xs font-medium text-warning-foreground">
            <ShieldAlertIcon className="size-3.5" />
            High impact · off unless you need them
          </div>
          {PERMISSION_OPTIONS.filter((option) => option.highImpact).map((option) => (
            <PermissionRow
              key={option.key}
              label={option.label}
              description={option.description}
              checked={agent.permissions[option.key]}
              disabled={disabled}
              onChange={(value) => setPermission(option.key, value)}
            />
          ))}
        </div>
        <p
          className={cn(
            "mx-2.5 mt-1.5 text-xs",
            workStart.outcome === "starts" ? "text-foreground/70" : "text-muted-foreground",
          )}
        >
          Work: {workStart.text}
        </p>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-notify" title="Notifications">
        <div className="flex min-h-8 items-center gap-2.5 px-2.5">
          <BellIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="flex-1 text-sm font-medium text-foreground/80">Tell me</span>
          <div className="w-60 shrink-0">
            <Select
              value={agent.notifyPolicy}
              disabled={disabled}
              onValueChange={(value) => {
                if (value && value in NOTIFY_LABEL && value !== agent.notifyPolicy)
                  void saveProfile({ notifyPolicy: value as keyof typeof NOTIFY_LABEL });
              }}
            >
              <SelectTrigger size="xs" aria-label="When to notify">
                <SelectValue>{NOTIFY_LABEL[agent.notifyPolicy]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(NOTIFY_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value} label={label}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="agent-triggers"
        title="Triggers"
        actions={
          <ThreadDetailsControl
            part="icon"
            aria-label="Add a trigger"
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "trigger:new" })}
          >
            <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </ThreadDetailsControl>
        }
      >
        {agent.triggers.length === 0 && !isEditing("trigger:new") && (
          <DetailRow
            icon={ZapIcon}
            label="Add a trigger"
            detail="Wake it on a schedule, when something happens, or on a webhook. Each wake-up is one recorded run."
            tone="muted"
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "trigger:new" })}
          />
        )}
        {agent.triggers.map((trigger) =>
          isEditing("trigger", trigger.id) ? (
            <TriggerForm
              key={trigger.id}
              {...triggerFormProps}
              initial={trigger}
              pending={pending}
              onCancel={close}
              onSave={saveTrigger}
            />
          ) : (
            <div key={trigger.id} className="flex items-center">
              <DetailRow
                icon={ZapIcon}
                label={trigger.title}
                detail={`${describeSchedule(trigger.schedule, filterNames)}${trigger.enabled ? "" : " · Paused"}`}
                className="flex-1"
                disabled={!canWrite}
                onClick={() => setEditing({ kind: "trigger", id: trigger.id })}
              />
              <Switch
                size="sm"
                className="mx-1"
                checked={trigger.enabled}
                aria-label={`Enable ${trigger.title}`}
                disabled={disabled}
                onCheckedChange={(enabled) =>
                  void mutate(() => client.setTriggerEnabled(agent, trigger.id, enabled))
                }
              />
              {trigger.schedule.type === "event" ? (
                // The server refuses manual runs: an event run needs a real source event.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        part="icon"
                        aria-label={`Run ${trigger.title} now`}
                        aria-disabled
                      />
                    }
                  >
                    <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  </TooltipTrigger>
                  <TooltipPopup>{EVENT_RUN_NOW_UNSUPPORTED_MESSAGE}</TooltipPopup>
                </Tooltip>
              ) : (
                <ThreadDetailsControl
                  part="icon"
                  aria-label={`Run ${trigger.title} now`}
                  title="Run now"
                  disabled={disabled}
                  onClick={() => void mutate(() => client.runTrigger(agent, trigger.id))}
                >
                  <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                </ThreadDetailsControl>
              )}
              <ThreadDetailsControl
                part="icon"
                aria-label={`Delete trigger ${trigger.title}`}
                title="Delete"
                disabled={disabled}
                onClick={() => void mutate(() => client.deleteTrigger(agent, trigger.id))}
              >
                <Trash2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              </ThreadDetailsControl>
            </div>
          ),
        )}
        {isEditing("trigger:new") && (
          <TriggerForm
            {...triggerFormProps}
            pending={pending}
            onCancel={close}
            onSave={saveTrigger}
          />
        )}
      </ThreadDetailsSection>

      {client.MemorySection ? (
        <client.MemorySection agent={agent} labels={workspace.labels} />
      ) : (
        <ThreadDetailsSection
          headingId="agent-memory"
          title="Memory"
          actions={
            <ThreadDetailsControl
              part="icon"
              aria-label="Add a memory note"
              disabled={!canWrite}
              onClick={() => setEditing({ kind: "memory:new" })}
            >
              <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            </ThreadDetailsControl>
          }
        >
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
              disabled={!canWrite}
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
                detail={`${formatMessageTime(note.updatedAt)} · ${
                  // Notes the agent saves itself name the conversation thread.
                  note.source.startsWith("thread:") ? "from a conversation" : note.source
                }`}
                disabled={!canWrite}
                onClick={() => setEditing({ kind: "memory", id: note.id })}
              />
            ),
          )}
        </ThreadDetailsSection>
      )}

      <ThreadDetailsSection headingId="agent-danger" title="Danger zone">
        {isEditing("delete") ? (
          <>
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              Delete {agent.name}, its triggers and memory? Its conversation and Work threads
              remain.
            </p>
            <DetailRow
              icon={Trash2Icon}
              label="Delete agent"
              tone="destructive"
              disabled={disabled}
              onClick={() =>
                void mutate(async () => {
                  await client.remove(agent);
                  onDeleted?.();
                })
              }
            />
            <DetailRow icon={XIcon} label="Keep agent" onClick={close} />
          </>
        ) : (
          <DetailRow
            icon={Trash2Icon}
            label="Delete agent"
            tone="destructive"
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "delete" })}
          />
        )}
      </ThreadDetailsSection>
      {!canWrite && (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          This connection can view this agent but not change it.
        </p>
      )}
      {error && (
        <p className="px-4 py-2.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PermissionRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1 hover:bg-muted/40">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground/80">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

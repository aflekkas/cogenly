import { DisclosureChevron } from "~/components/ui/disclosure";
import {
  BellIcon,
  BookmarkIcon,
  ShieldCheckIcon,
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentAvatar, AgentPermissions } from "@t3tools/contracts";
import { PopoverTrigger } from "~/components/ui/popover";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { AgentActivity } from "./AgentActivity";
import { AgentOpenItems } from "./AgentOpenItems";
import { scheduleInWords } from "./agentBuilder.logic";
import type { AgentDetailsSection } from "./agentViewIntent";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { useAgentsClient } from "./agentsClient";
import { agentDraft, formatMessageTime } from "./agents.logic";
import {
  EVENT_RUN_NOW_UNSUPPORTED_MESSAGE,
  PERMISSION_OPTIONS,
  agentWorkStartPolicy,
  countOpenCommitments,
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
 * The Details sheet's sections: identity and responsibility, schedule, tools, open
 * items, activity, memory and the advanced settings, edited in place. Every change here
 * is the owner's own decision and saves directly; the agent can only ask for these.
 */
export function AgentResponsibilities({
  agent,
  workspace,
  section,
  onOpenChat,
  onDeleted,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  /** The section to open on; the collapsed ones stay collapsed. */
  section: AgentDetailsSection;
  onOpenChat: (messageId?: string) => void;
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
  const [itemsOpen, setItemsOpen] = useState(section === "items");
  const [activityOpen, setActivityOpen] = useState(section === "activity");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [highImpactOpen, setHighImpactOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const grantedLabels = PERMISSION_OPTIONS.filter(
    (option) => !option.highImpact && agent.permissions[option.key],
  ).map((option) => option.label);
  const openItems = agent.approvals.length + countOpenCommitments(workspace.commitments);
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
    environmentId: agent.environmentId,
    onManageProjects: client.openProjectSettings,
  };
  const saveTrigger = async (value: Parameters<typeof client.saveTrigger>[1]) => {
    // Errors stay in the form, where an out-of-scope filter can be fixed.
    await client.saveTrigger(agent, value);
    close();
  };

  return (
    <div className="flex w-full flex-col">
      <ThreadDetailsSection
        headingId="agent-responsibility"
        title="Responsibility"
        separated={false}
      >
        <AgentAvatarPicker avatar={avatar} onChange={(next) => void saveAvatar(next)}>
          <PopoverTrigger
            disabled={!canWrite}
            render={<DetailRow icon={SmileIcon} label="Face" value="Choose" />}
          />
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
            label="Owns"
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
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="agent-triggers"
        title="Schedule"
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
        {agent.triggers.length === 0 && (
          <DetailRow
            icon={ZapIcon}
            label="Only when you message it"
            detail="Add a trigger to wake it on a schedule, when something happens, or on a webhook."
            tone="muted"
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "trigger:new" })}
          />
        )}
        {agent.triggers.map((trigger) => (
          <div key={trigger.id} className="flex items-center">
            <DetailRow
              icon={ZapIcon}
              label={
                trigger.schedule.type === "event"
                  ? describeSchedule(trigger.schedule, filterNames)
                  : scheduleInWords(trigger.schedule)
              }
              detail={`${trigger.title}${trigger.enabled ? "" : " · Paused"}`}
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
        ))}
        {/* The full trigger editor, every schedule kind and filter, as a dialog. */}
        <Dialog
          open={isEditing("trigger:new") || isEditing("trigger")}
          onOpenChange={(open) => !open && close()}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                {isEditing("trigger:new") ? "Add a trigger" : "Edit trigger"}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <TriggerForm
                {...triggerFormProps}
                {...(editing?.kind === "trigger"
                  ? { initial: agent.triggers.find((trigger) => trigger.id === editing.id) }
                  : {})}
                pending={pending}
                onCancel={close}
                onSave={saveTrigger}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-permissions" title="Tools & permissions">
        {/* One line says what it may do; the switches unfold under it. */}
        <Collapsible open={permissionsOpen} onOpenChange={setPermissionsOpen}>
          <CollapsibleTrigger
            render={
              <DetailRow
                icon={ShieldCheckIcon}
                label={grantedLabels.length > 0 ? grantedLabels.join(" · ") : "Nothing yet"}
                detail={workStart.text}
                trailing={<DisclosureChevron />}
              />
            }
          />
          <CollapsiblePanel>
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
            <Collapsible open={highImpactOpen} onOpenChange={setHighImpactOpen}>
              <CollapsibleTrigger
                render={
                  <DetailRow
                    icon={ShieldAlertIcon}
                    label="High impact"
                    value={
                      PERMISSION_OPTIONS.filter(
                        (option) => option.highImpact && agent.permissions[option.key],
                      )
                        .map((option) => option.label)
                        .join(", ") || "off"
                    }
                    tone="muted"
                    trailing={<DisclosureChevron />}
                  />
                }
              />
              <CollapsiblePanel>
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
              </CollapsiblePanel>
            </Collapsible>
          </CollapsiblePanel>
        </Collapsible>
      </ThreadDetailsSection>

      <CollapsibleDetails
        id="agent-items"
        title="Open items"
        count={openItems}
        open={itemsOpen}
        onOpenChange={setItemsOpen}
      >
        <AgentOpenItems agent={agent} workspace={workspace} onOpenChat={onOpenChat} />
      </CollapsibleDetails>

      <CollapsibleDetails
        id="agent-activity"
        title="Recent activity"
        open={activityOpen}
        onOpenChange={setActivityOpen}
      >
        <AgentActivity
          agent={agent}
          workspace={workspace}
          onOpenChat={() => onOpenChat()}
          onOpenItems={() => setItemsOpen(true)}
        />
      </CollapsibleDetails>

      {client.MemorySection ? (
        <CollapsibleDetails
          id="agent-memory"
          title="Memory"
          open={memoryOpen}
          onOpenChange={setMemoryOpen}
        >
          <client.MemorySection agent={agent} labels={workspace.labels} />
        </CollapsibleDetails>
      ) : (
        <CollapsibleDetails
          id="agent-memory"
          title="Memory"
          count={agent.memory.length}
          open={memoryOpen}
          onOpenChange={setMemoryOpen}
        >
          <DetailRow
            icon={PlusIcon}
            label="Add a note"
            tone="muted"
            disabled={!canWrite}
            onClick={() => setEditing({ kind: "memory:new" })}
          />
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
        </CollapsibleDetails>
      )}

      <CollapsibleDetails
        id="agent-advanced"
        title="Advanced"
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <div className="flex min-h-8 items-center gap-2.5 px-2.5">
          <BellIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="flex-1 text-sm font-medium text-foreground/80">Tell me</span>
          <div className="w-52 shrink-0">
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
        <DailyCapRow
          cap={agent.dailyRunCap}
          pending={disabled}
          onSave={(dailyRunCap) => saveProfile({ dailyRunCap })}
        />
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
      </CollapsibleDetails>
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

/** A section that folds away: open items, activity and the advanced settings. */
function CollapsibleDetails({
  id,
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <ThreadDetailsSection
      headingId={id}
      title={title}
      meta={count !== undefined && count > 0 ? count : undefined}
      collapsible={{ open, onOpenChange }}
    >
      {children}
    </ThreadDetailsSection>
  );
}

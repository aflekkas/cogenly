import { cn, randomUUID } from "~/lib/utils";
import {
  BellIcon,
  BookmarkIcon,
  BotIcon,
  FlagIcon,
  FolderGit2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ShieldAlertIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import type { AgentPermissions, ProjectLabelId } from "@t3tools/contracts";
import { AgentFace } from "~/components/agents/face";
import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { ProjectLabelPicker } from "~/projectLabels/ProjectLabelPicker";
import { ProjectTag } from "~/projectLabels/ProjectTag";
import { useAgents, useAgentsClient } from "./agentsClient";
import {
  agentDraft,
  agentStatusLabel,
  formatMessageTime,
  modelDisplayName,
  sameModel,
} from "./agents.logic";
import {
  AUTONOMY_OPTIONS,
  PERMISSION_OPTIONS,
  SCOPE_ACCESS_LABEL,
  agentWorkStartPolicy,
  describeSchedule,
  scopeAccess,
  scopePermissions,
  startWorkRepositories,
  toggleScope,
  type FilterNames,
} from "./agentWorkspace.logic";
import { DailyCapRow, DetailRow, InlineEditor, TriggerForm, chevron } from "./AgentDetails";
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
  const { models: allModels } = useAgents();
  const models = allModels.filter(
    (model) => !model.environmentId || model.environmentId === agent.environmentId,
  );
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
  const status = agentStatusLabel(agent);
  const labelsById = new Map(workspace.labels.map((label) => [label.id as string, label]));
  const workStart = agentWorkStartPolicy(agent);
  const setPermission = (key: keyof AgentPermissions, value: boolean) =>
    void saveProfile({ permissions: { ...agent.permissions, [key]: value } });
  const disabled = pending || !canWrite;
  // Event triggers can name only what the agent can read: its scoped projects, its home
  // repository and the repositories those projects link.
  const scopedLabels = workspace.labels.filter((label) =>
    agent.scope.some((entry) => entry.labelId === label.id),
  );
  const home = workspace.repositories.find((repository) => repository.id === agent.projectId);
  const triggerRepositories = [
    ...(home ? [home] : []),
    ...startWorkRepositories(agent.scope, workspace.labels, workspace.repositories)
      .filter((repository) => repository.id !== agent.projectId)
      .map(({ id, title }) => ({ id, title })),
  ];
  const filterNames: FilterNames = {
    labelName: (id) => labelsById.get(id)?.name,
    repositoryName: (id) =>
      workspace.repositories.find((repository) => repository.id === id)?.title,
  };
  const triggerFormProps = {
    labels: scopedLabels,
    repositories: triggerRepositories,
    onManageProjects: client.openProjectSettings,
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col pb-10">
      <ThreadDetailsSection
        headingId="agent-profile"
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
              {status === "Paused" && agent.pauseReason ? `Paused · ${agent.pauseReason}` : status}
            </span>
          </span>
          <ThreadDetailsControl
            part="icon"
            aria-label="New face"
            title="New face"
            disabled={disabled}
            onClick={() => void saveProfile({ avatar: { seed: randomUUID() } })}
          >
            <RefreshCwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </ThreadDetailsControl>
        </div>
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
        {/* Pausing is the visible off switch: no triggers or autonomous runs, chat still works. */}
        <div className="flex items-center gap-2.5 px-2.5 py-1.5">
          {agent.enabled ? (
            <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          ) : (
            <PauseIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground/80">
              {agent.enabled ? "Active" : "Paused"}
            </span>
            <span className="text-xs text-muted-foreground">
              {agent.enabled
                ? `Wakes on its triggers, up to ${agent.dailyRunCap} runs a day. You can always chat.`
                : "No triggers or background runs. You can still chat with it."}
            </span>
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void saveProfile({ enabled: !agent.enabled })}
          >
            {agent.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
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
        <Menu>
          <MenuTrigger
            render={
              <DetailRow
                icon={BotIcon}
                label="Model"
                value={
                  client.modelStatus?.(agent, agent.modelSelection).status === "unavailable"
                    ? `${agent.modelSelection.model} · unavailable`
                    : modelDisplayName(models, agent.modelSelection)
                }
                trailing={chevron}
                disabled={disabled}
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
        <DetailRow
          icon={FolderGit2Icon}
          label="Home repository"
          value={
            workspace.repositories.find((repository) => repository.id === agent.projectId)?.title ??
            "None"
          }
          detail="Where its conversation runs. Execute-level agents may start Work here without asking."
          disabled
        />
        <DailyCapRow
          cap={agent.dailyRunCap}
          pending={disabled}
          onSave={(dailyRunCap) => saveProfile({ dailyRunCap })}
        />
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="agent-scope"
        title="Project scope"
        actions={
          <ProjectLabelPicker
            onManage={client.openProjectSettings}
            labels={workspace.labels}
            selectedIds={agent.scope.map((entry) => entry.labelId)}
            disabled={disabled}
            onToggle={(labelId, selected) =>
              void saveProfile({ scope: toggleScope(agent.scope, labelId, selected) })
            }
          />
        }
      >
        <p className="px-2.5 pb-2 text-xs text-muted-foreground">
          Project tags give context only. The agent can read and record open items only in the
          projects granted here.
        </p>
        {agent.scope.length === 0 && (
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">
            No projects granted. It sees only its own conversation and items.
          </p>
        )}
        {agent.scope.map((entry) => {
          const label = labelsById.get(entry.labelId);
          const access = scopeAccess(entry.permissions);
          return (
            <div key={entry.labelId} className="flex min-h-8 items-center gap-2 px-2.5 py-0.5">
              {label ? (
                <ProjectTag name={label.name} color={label.color} />
              ) : (
                <span className="text-xs text-muted-foreground">Deleted project</span>
              )}
              <span className="flex-1" />
              <div className="w-40 shrink-0">
                <Select
                  value={access}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value !== "read" && value !== "draft") return;
                    void saveProfile({
                      scope: agent.scope.map((item) =>
                        item.labelId === entry.labelId
                          ? { ...item, permissions: scopePermissions(value) }
                          : item,
                      ),
                    });
                  }}
                >
                  <SelectTrigger size="xs" aria-label={`Access to ${label?.name ?? "project"}`}>
                    <SelectValue>{SCOPE_ACCESS_LABEL[access]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="read" label={SCOPE_ACCESS_LABEL.read}>
                      Read
                    </SelectItem>
                    <SelectItem value="draft" label={SCOPE_ACCESS_LABEL.draft}>
                      Read & draft open items
                    </SelectItem>
                    {access === "custom" && (
                      <SelectItem value="custom" label={SCOPE_ACCESS_LABEL.custom} disabled>
                        Custom
                      </SelectItem>
                    )}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${label?.name ?? "project"} from scope`}
                disabled={disabled}
                onClick={() =>
                  void saveProfile({
                    scope: toggleScope(agent.scope, entry.labelId as ProjectLabelId, false),
                  })
                }
              >
                <XIcon />
              </Button>
            </div>
          );
        })}
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="agent-autonomy" title="Autonomy">
        <RadioGroup
          value={agent.autonomy}
          disabled={disabled}
          onValueChange={(value) => {
            const option = AUTONOMY_OPTIONS.find((candidate) => candidate.value === value);
            if (option && option.value !== agent.autonomy)
              void saveProfile({ autonomy: option.value });
          }}
        >
          {AUTONOMY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 hover:bg-muted/40"
            >
              <Radio value={option.value} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground/80">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <p
          className={cn(
            "mx-2.5 mt-1.5 text-xs",
            workStart.outcome === "home_only" ? "text-foreground/70" : "text-muted-foreground",
          )}
        >
          Work: {workStart.text}
        </p>
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
              <ThreadDetailsControl
                part="icon"
                aria-label={`Run ${trigger.title} now`}
                title={agent.enabled ? "Run now" : "Resume the agent to run triggers"}
                disabled={disabled || !agent.enabled}
                onClick={() => void mutate(() => client.runTrigger(agent, trigger.id))}
              >
                <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              </ThreadDetailsControl>
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
            onSave={(value) =>
              mutate(async () => {
                await client.saveTrigger(agent, value);
                close();
              })
            }
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

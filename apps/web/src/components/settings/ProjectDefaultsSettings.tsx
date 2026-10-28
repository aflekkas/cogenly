import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type WorktreeSubmodules,
} from "@cogenly/contracts";
import { createModelSelection } from "@cogenly/shared/model";
import { resolveProjectFileSettings } from "@cogenly/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsTag } from "./SettingsStatus";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

/**
 * The default rows that new threads, repositories and agents start from,
 * grouped by the settings page that shows them.
 */
export function ProjectDefaultsSettings({ category }: { category: "models" | "new-threads" }) {
  const { target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const unavailable = connectedEnvironments.length === 0;
  // File-backed keys show their effective value; with no repository in view a
  // null file only fills the built-in. The reset arrow beside the title clears
  // the setting, so the picker has no "inherit" item.
  const effective = target ? resolveProjectFileSettings(target.settings, null).settings : null;

  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      {...searchableSetting("default-model")}
      description="Used for new chats and threads. Automatic uses the first available model."
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label="default model" onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {/* Until a model is picked, the picker shows the automatic fallback. */}
            {!unavailable && settings.defaultModelSelection === null ? (
              <SettingsTag>Automatic</SettingsTag>
            ) : null}
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                setModel(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No providers available</span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      {...searchableSetting("new-threads")}
      description="A new worktree gives each thread its own branch and folder."
      resetAction={
        settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label="default workspace"
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={effective?.defaultThreadEnvMode ?? null}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Start new threads in">
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? resolveEnvModeLabel(value)
                  : "Unavailable"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
            <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  // The Models page puts the default model in a section of its own.
  if (category === "models") return modelRow;

  return (
    <SettingsSection
      id="project-defaults"
      title="Workspace"
      footer="Until you set them here, a repository's cogenly.json decides where new threads start and which submodules they check out."
    >
      {workspaceRow}
      <SettingsRow
        serverScoped
        settingKeys={["newWorktreesStartFromOrigin"]}
        {...searchableSetting("start-from-origin")}
        description="Branch new worktrees from the latest commit on origin instead of your local copy of the branch."
        resetAction={
          settings.newWorktreesStartFromOrigin !==
          DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin ? (
            <SettingResetButton
              label="new worktrees start from origin"
              onClick={() =>
                updateSettings({
                  newWorktreesStartFromOrigin: DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.newWorktreesStartFromOrigin}
            onCheckedChange={(checked) =>
              updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
            }
            aria-label="Start worktrees from origin"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["worktreeSubmodules"]}
        {...searchableSetting("worktree-submodules")}
        description="Which git submodules a new worktree checks out."
        resetAction={
          settings.worktreeSubmodules !== null ? (
            <SettingResetButton
              label="worktree submodules"
              onClick={() => updateSettings({ worktreeSubmodules: null })}
            />
          ) : null
        }
        control={
          <Select
            value={effective?.worktreeSubmodules ?? null}
            onValueChange={(value) => {
              if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Worktree submodules">
              <SelectValue>
                {(value: string | null) =>
                  isWorktreeSubmodules(value) ? WORKTREE_SUBMODULES_LABELS[value] : "Unavailable"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {WORKTREE_SUBMODULES_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

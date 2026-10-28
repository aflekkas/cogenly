import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import type { ProviderInstanceId, SourceControlWritingStyleMode } from "@cogenly/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cogenly/contracts/settings";
import { createModelSelection } from "@cogenly/shared/model";
import { resolveSourceControlWriterModelSelection } from "@cogenly/shared/serverSettings";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { DisclosurePanel } from "../ui/disclosure";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsField,
  SettingsModelPickers,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { searchableSetting } from "./settingsSearch";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: "Repository conventions",
      description: "Matches each repository's recent commit messages and pull request titles.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description: "Uses Conventional Commit prefixes and keeps pull request text short.",
    },
    custom: {
      label: "Custom instructions",
      description: "Follows your instructions in every repository.",
    },
  };

export function SourceControlWritingSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  // The representative supplies the provider list; a model choice is checked
  // against every target before it fans out.
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    style.mode !== defaults.mode || style.customInstructions !== defaults.customInstructions;

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(textGenerationProviders), settings),
  );
  // The text generation default can name an instance this machine turned off.
  const enabledInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const enabledTextGenerationProviders = textGenerationProviders.filter((provider) =>
    enabledInstanceIds.has(provider.instanceId),
  );
  const defaultModelSelection = resolveAppModelSelectionState(
    settings,
    enabledTextGenerationProviders,
  );
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const activeSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        settings,
        enabledTextGenerationProviders,
      ),
    },
    enabledTextGenerationProviders,
  );
  const canEnableDedicatedModel = instanceEntries.some(
    (entry) =>
      entry.instanceId === defaultModelSelection.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    enabledTextGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const writerInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  return (
    <SettingsSection id="source-control-text-generation" title="Generated text">
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        {...searchableSetting("source-control-writing-style")}
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label="source control writing style"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <SettingsField>
            <Select
              value={style.mode}
              onValueChange={(value) => {
                const customInstructions = customInstructionsRef.current?.value.trim();
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: value as SourceControlWritingStyleMode,
                    ...(customInstructions !== undefined ? { customInstructions } : {}),
                  },
                });
              }}
            >
              <SelectTrigger size="sm" aria-label="Writing style">
                <SelectValue>
                  {(value: SourceControlWritingStyleMode) => MODE_OPTIONS[value].label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {MODE_OPTIONS[mode].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </SettingsField>
        }
      >
        <DisclosurePanel open={style.mode === "custom"}>
          <div className="mt-3 max-w-2xl">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder="Keep titles concise. Use short bullet points in descriptions."
              aria-label="Custom source control writing instructions"
            />
          </div>
        </DisclosurePanel>
      </SettingsRow>

      <BranchNamingSettings />

      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWriterModelSelection"]}
        {...searchableSetting("source-control-writer-model")}
        description="Writes commit messages, pull requests and branch names. Off uses the text generation model from Models."
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              Connect a machine to choose a writing model.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {usesDedicatedModel && !canEnableDedicatedModel ? (
                <span className="text-sm text-muted-foreground">
                  No text generation providers available.
                </span>
              ) : null}
              {usesDedicatedModel && canEnableDedicatedModel ? (
                <SettingsModelPickers>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={activeSelection.instanceId}
                    model={activeSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="field"
                    triggerAriaLabel="Writing model"
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    getModelDisabledReason={writerModelDisabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = writerModelDisabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: "Writing model not saved",
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                      });
                    }}
                  />
                  {writerInstanceEntry ? (
                    <TraitsPicker
                      provider={writerInstanceEntry.driverKind}
                      models={writerInstanceEntry.models}
                      model={activeSelection.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={activeSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={
                        settings.planModeEnabled || selectsPlanAgent(activeSelection.options)
                      }
                      triggerVariant="field"
                      onModelOptionsChange={(options) =>
                        updateSettings({
                          sourceControlWriterModelSelection: createModelSelection(
                            activeSelection.instanceId,
                            activeSelection.model,
                            options,
                          ),
                        })
                      }
                    />
                  ) : null}
                </SettingsModelPickers>
              ) : null}
              <Switch
                checked={usesDedicatedModel}
                disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                onCheckedChange={(checked) =>
                  updateSettings({
                    sourceControlWriterModelSelection: checked
                      ? createModelSelection(
                          defaultModelSelection.instanceId,
                          defaultModelSelection.model,
                          defaultModelSelection.options,
                        )
                      : null,
                  })
                }
                aria-label="Use a separate writing model"
              />
            </div>
          )
        }
      />
    </SettingsSection>
  );
}

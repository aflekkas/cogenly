import { useNavigate } from "@tanstack/react-router";
import { ProviderDriverKind, type ProviderInstanceId } from "@cogenly/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cogenly/contracts/settings";
import { createModelSelection } from "@cogenly/shared/model";
import * as Equal from "effect/Equal";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

/** Settings → Models: which models new threads and generated text use. */
export function ModelsSettingsPanel() {
  const navigate = useNavigate();
  return (
    <SettingsSection
      id="models"
      title="Defaults"
      footer={
        <>
          To hide, reorder or add models, open a provider in{" "}
          <InlineButton tone="muted" onClick={() => void navigate({ to: "/settings/providers" })}>
            Providers
          </InlineButton>
          .
        </>
      }
    >
      <ProjectDefaultsSettings category="models" />
      <TextGenerationModelRow />
    </SettingsSection>
  );
}

function TextGenerationModelRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  // The representative environment supplies the provider list for the picker.
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(textGenerationProviders), settings),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["textGenerationModelSelection"]}
      {...searchableSetting("text-generation-model")}
      description="Writes thread titles, greetings and other short text. Source control can pick its own."
      resetAction={
        hasServerTargets && isTextGenerationModelDirty ? (
          <SettingResetButton
            label="text generation model"
            onClick={() =>
              updateSettings({
                textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        !hasServerTargets ? (
          <span className="text-sm text-muted-foreground">Connect a machine to choose one</span>
        ) : !hasTextGenerationProvider ? (
          <span className="text-sm text-muted-foreground">No providers available</span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={textGenInstanceId}
              model={textGenModel}
              lockedProvider={null}
              instanceEntries={textGenerationModelInstanceEntries}
              modelOptionsByInstance={textGenerationModelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={textGenerationModelDisabledReason}
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
              onInstanceModelChange={(instanceId, model) => {
                const reason = textGenerationModelDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: "Text generation model not saved",
                    description: reason,
                  });
                  return;
                }
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: createModelSelection(instanceId, model),
                    },
                    textGenerationProviders,
                  ),
                });
              }}
            />
            {textGenInstanceEntry ? (
              <TraitsPicker
                provider={textGenProvider}
                // The exact instance's models (rather than the first kind
                // match), so a custom text-gen instance like
                // `codex_personal` gets its own model list.
                models={textGenInstanceEntry.models}
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled || selectsPlanAgent(textGenModelOptions)}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      textGenerationProviders,
                    ),
                  });
                }}
              />
            ) : null}
          </div>
        )
      }
    />
  );
}

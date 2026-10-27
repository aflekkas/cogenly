import { useRef } from "react";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ThreadTitleInstructionsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const edited = useRef(false);
  return (
    <SettingsSection title="Thread titles">
      <SettingsRow
        serverScoped
        settingKeys={["threadTitleInstructions"]}
        {...searchableSetting("thread-title-instructions")}
        description="Extra guidance for automatic titles and title regeneration. A repository's cogenly.json can override this with threadTitleInstructions."
        resetAction={
          settings.threadTitleInstructions !== "" ? (
            <SettingResetButton
              label="thread title instructions"
              onClick={() => updateSettings({ threadTitleInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${scopeKey}:${settings.threadTitleInstructions}`}
            aria-label="Thread title instructions"
            rows={4}
            defaultValue={settings.threadTitleInstructions}
            placeholder="For example, write titles in Spanish."
            onChange={() => {
              edited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && value !== settings.threadTitleInstructions)
                updateSettings({ threadTitleInstructions: value });
              edited.current = false;
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

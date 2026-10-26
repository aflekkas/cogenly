import { useRef } from "react";
import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@cogenly/contracts";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { BRANCH_NAMING_MODE_LABELS as MODES } from "./settingValueLabels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function BranchNamingSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const prefixEdited = useRef(false);
  const instructionsEdited = useRef(false);
  const updateSettings = useUpdateScopedSettings();

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["branchNamingMode"]}
        {...searchableSetting("worktree-branch-naming")}
        description="How a new worktree's branch is named from your first message."
        status={
          settings.branchNamingMode === "semantic"
            ? "The model chooses a prefix that describes the work, such as feat/add-search, fix/login-timeout, or refactor/auth."
            : undefined
        }
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode ? (
            <SettingResetButton
              label="branch naming"
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Branch names">
              <SelectValue>{(value: BranchNamingMode) => MODES[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNamePrefix"]}
          title="Branch prefix"
          description="For example, c or c/ produces c/add-search. Leave empty for no prefix."
          resetAction={
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label="branch prefix"
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <Input
              key={`${scopeKey}:${settings.branchNamePrefix}`}
              aria-label="Branch prefix"
              autoCapitalize="none"
              spellCheck={false}
              onChange={() => {
                prefixEdited.current = true;
              }}
              placeholder="No prefix"
              defaultValue={settings.branchNamePrefix}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (prefixEdited.current && value !== settings.branchNamePrefix)
                  updateSettings({ branchNamePrefix: value });
                prefixEdited.current = false;
              }}
            />
          }
        />
      ) : null}
      {settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNameInstructions"]}
          title="Branch naming instructions"
          description="Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added."
          resetAction={
            settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label="branch naming instructions"
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${settings.branchNameInstructions}`}
              aria-label="Branch naming instructions"
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={settings.branchNameInstructions}
              placeholder="Use julius/ followed by the issue ID and a short description."
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (instructionsEdited.current && value !== settings.branchNameInstructions)
                  updateSettings({ branchNameInstructions: value });
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}

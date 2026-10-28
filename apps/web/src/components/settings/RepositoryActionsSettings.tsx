import { AuthSettingsWriteScope, type T3ProjectFileScript } from "@cogenly/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@cogenly/shared/keybindings";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useProjectConfigFileState } from "../../hooks/useProjectConfigFile";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection, SettingsSectionAction } from "./settingsLayout";

/**
 * A repository's actions, on the Repository page. They are stored on each
 * checkout; editing them here writes every checkout of the group. Shortcuts
 * are machine-wide, so the same action id shares its binding on a machine.
 */
export function RepositoryActionsSettings({
  members,
  canEdit,
}: {
  members: readonly SidebarProjectGroupMember[];
  canEdit: boolean;
}) {
  const { environments } = useEnvironments();
  const writableIds = useEnvironmentsWithScope(members, AuthSettingsWriteScope);
  const canWriteSettings =
    canEdit && members.every((member) => writableIds.has(member.environmentId));
  const representative =
    members.find(
      (member) =>
        environments.find((environment) => environment.environmentId === member.environmentId)
          ?.serverConfig != null,
    ) ?? members[0];
  const representativeConfig = representative
    ? environments.find((environment) => environment.environmentId === representative.environmentId)
        ?.serverConfig
    : undefined;
  const scripts = representative && representativeConfig ? representative.scripts : [];
  const keybindings = representativeConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const { saving, persist, submit } = useProjectScriptSettings(members);

  // A repository's cogenly.json can declare actions to import.
  const configFile = useProjectConfigFileState(
    representative?.environmentId ?? members[0]!.environmentId,
    representative?.workspaceRoot ?? null,
  );
  const importableScripts = useMemo(
    () =>
      configFile.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, configFile.scripts],
  );
  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
        runOnSettle: fileScript.runOnSettle ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submit(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submit, setRequest],
  );

  return (
    <SettingsSection
      id="project-actions"
      title="Actions"
      footer="Commands that run in this repository or its worktrees, with optional shortcuts. Saved on every checkout of this repository."
      headerAction={
        // A fragment, so "Add action" stays the header's last child and reaches the card edge.
        <>
          {importableScripts.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    id="import-scripts"
                    size="xs"
                    variant="ghost-muted"
                    disabled={saving || !canWriteSettings}
                    type="button"
                  />
                }
              >
                Import scripts
                <ChevronDownIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Import from {configFile.fileName}</MenuGroupLabel>
                  <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                    Add actions declared by this checkout without editing them first.
                  </p>
                </MenuGroup>
                <MenuSeparator />
                {importableScripts.map((fileScript) => (
                  <MenuItem
                    key={`${fileScript.name} ${fileScript.command}`}
                    onClick={() => void importFileScript(fileScript)}
                  >
                    <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{fileScript.name}</div>
                      <div className="truncate font-mono text-muted-foreground">
                        {fileScript.command}
                      </div>
                    </div>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
          <SettingsSectionAction
            disabled={saving || !canWriteSettings}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            Add action
          </SettingsSectionAction>
        </>
      }
    >
      <ProjectActionsList
        scripts={scripts}
        keybindings={keybindings}
        disabled={saving || !canWriteSettings}
        onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
      />
      {configFile.status === "invalid" ? (
        <SettingsRow
          title={`${configFile.fileName} is invalid`}
          description={`A ${configFile.fileName} exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values.`}
          className="text-warning"
        />
      ) : null}
      {representative ? (
        <ProjectScriptEditorDialog
          environmentId={representative.environmentId}
          editScope={AuthSettingsWriteScope}
          request={request}
          scripts={scripts}
          onSubmit={submit}
          onDelete={(id) =>
            void persist((current) => current.filter((script) => script.id !== id), id, null)
          }
          onClose={() => setRequest(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

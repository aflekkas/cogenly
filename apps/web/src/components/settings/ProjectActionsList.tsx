import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { SettingsIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { ScriptIcon } from "../projectScriptEditor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsNote, SettingsRow } from "./settingsLayout";

export function ProjectActionsList({
  scripts,
  keybindings,
  disabled,
  onEdit,
}: {
  scripts: readonly ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
  onEdit: (script: ProjectScript) => void;
}) {
  if (scripts.length === 0) return <SettingsNote>No actions configured.</SettingsNote>;
  return scripts.map((script) => {
    const shortcutLabel = shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
    return (
      <SettingsRow
        key={script.id}
        className="group"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{script.name}</span>
            {script.runOnWorktreeCreate ? (
              <Badge size="sm" variant="outline">
                setup
              </Badge>
            ) : null}
            {script.runOnSettle ? (
              <Badge size="sm" variant="outline">
                on settle
              </Badge>
            ) : null}
            {script.previewUrl ? (
              <span className="flex max-sm:hidden">
                <Badge size="sm" variant="outline">
                  preview · desktop only
                </Badge>
              </span>
            ) : null}
          </span>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        control={
          <>
            {shortcutLabel ? (
              <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
            ) : null}
            <span className="flex shrink-0 opacity-0 interactive group-focus-within:opacity-100 group-hover:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${script.name}`}
                disabled={disabled}
                onClick={() => onEdit(script)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </span>
          </>
        }
      />
    );
  });
}

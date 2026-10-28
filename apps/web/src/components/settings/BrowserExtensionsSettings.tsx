import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type EnvironmentId,
} from "@cogenly/contracts";
import { PuzzleIcon } from "lucide-react";
import { useState } from "react";

import { BrowserExtensionInstallForm } from "~/browser/BrowserExtensionInstall";
import { browserExtensionPermissionLines } from "~/browser/browserExtensions.logic";
import { useBrowserExtensions } from "~/browser/useBrowserExtensions";
import { useClientSettings } from "~/hooks/useSettings";

import { BrowserExtensionDetailsDialog } from "../preview/extensions/BrowserExtensionDetails";
import {
  BrowserExtensionIcon,
  BrowserExtensionStatusText,
} from "../preview/extensions/BrowserExtensionIcon";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsEmpty, SettingsField, SettingsNote, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Extensions per browser profile, kept by the selected machine. They run in
 * its built-in Chrome and stream into the web and desktop panels.
 */
export function BrowserExtensionsSetting() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return <BrowserExtensionsRow key={environmentId} environmentId={environmentId} />;
}

function BrowserExtensionsRow({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  // Incognito keeps nothing between sessions, so it has no extensions to manage.
  const profiles = resolveBrowserProfiles(userProfiles).filter(
    (profile) => profile.kind === "persistent",
  );
  const [chosenProfileId, setChosenProfileId] = useState<string>(DEFAULT_BROWSER_PROFILE_ID);
  const profile =
    profiles.find((candidate) => candidate.id === chosenProfileId) ?? profiles[0] ?? null;
  const profileId = profile?.id ?? DEFAULT_BROWSER_PROFILE_ID;
  const actions = useBrowserExtensions(environmentId, profileId);
  const { canManage, extensions, loadError, install, setEnabled, remove } = actions;
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = extensions?.find((extension) => extension.id === detailsId) ?? null;

  return (
    <SettingsRow
      {...searchableSetting("browser-extensions")}
      description="Extensions run in Cogenly's built-in Chrome on the selected machine. Desktop tabs in profiles with enabled extensions stream from it."
      control={
        <SettingsField>
          <Select
            disabled={!canManage}
            value={profileId}
            onValueChange={(value) => {
              if (value) setChosenProfileId(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Browser profile">
              <SelectValue>{profile?.name ?? "Default"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {profiles.map((candidate) => (
                <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsField>
      }
    >
      <div className="mt-2 grid gap-2">
        {!canManage ? (
          <p className="text-xs text-muted-foreground">
            {environmentId
              ? "You can't manage this machine's browser."
              : "Connect to a machine to manage its extensions."}
          </p>
        ) : (
          <SettingsGroup variant="inset" divided={extensions !== null && extensions.length > 0}>
            {extensions === null ? (
              <SettingsNote tone={loadError ? "destructive" : "muted"}>
                {loadError ?? "Loading extensions…"}
              </SettingsNote>
            ) : extensions.length === 0 ? (
              <SettingsEmpty icon={<PuzzleIcon />} label="No extensions in this profile yet." />
            ) : (
              extensions.map((extension) => (
                <div
                  key={extension.id}
                  className="flex min-h-11 items-center gap-3 px-3 py-2 sm:px-4"
                >
                  <BrowserExtensionIcon extension={extension} />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
                      <span className="truncate">{extension.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {extension.version}
                      </span>
                    </p>
                    <BrowserExtensionStatusText extension={extension} withDetail />
                    {browserExtensionPermissionLines(extension).map((line) => (
                      <p key={line} className="text-xs text-muted-foreground">
                        {line}
                      </p>
                    ))}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      size="sm"
                      aria-label={`Turn ${extension.name} ${extension.enabled ? "off" : "on"}`}
                      checked={extension.enabled}
                      onCheckedChange={(checked) => void setEnabled(extension.id, checked)}
                    />
                    <Button size="sm" variant="ghost" onClick={() => setDetailsId(extension.id)}>
                      Details
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      onClick={() => void remove(extension)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))
            )}
          </SettingsGroup>
        )}
        <BrowserExtensionInstallForm install={install} disabled={!canManage} />
      </div>
      <BrowserExtensionDetailsDialog
        extension={details}
        onClose={() => setDetailsId(null)}
        actions={actions}
      />
    </SettingsRow>
  );
}

import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type EnvironmentId,
} from "@cogenly/contracts";
import { useEffect, useState } from "react";

import { BrowserExtensionInstallForm } from "~/browser/BrowserExtensionInstall";
import { browserExtensionPermissionLines } from "~/browser/browserExtensions.logic";
import { useBrowserExtensions } from "~/browser/useBrowserExtensions";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Extensions per browser profile, kept by the selected machine. They load in
 * that machine's browser tabs, and in the desktop panel when the desktop app
 * runs on the same machine.
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
  const { canManage, extensions, loadError, reload, install, setEnabled, remove } =
    useBrowserExtensions(environmentId, profileId);

  // `reload` changes with the machine and profile, so each choice reads its own list.
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsRow
      {...searchableSetting("browser-extensions")}
      description="Chromium extensions for each profile on the selected machine. Its browser tabs load them, and so does the desktop panel when the app runs on that machine."
      control={
        <Select
          disabled={!canManage}
          value={profileId}
          onValueChange={(value) => {
            if (value) setChosenProfileId(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Browser profile">
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
      }
    >
      <div className="mt-2 mb-2 grid gap-2">
        {!canManage ? (
          <p className="text-sm text-muted-foreground">
            {environmentId
              ? "You can't manage this machine's browser."
              : "Connect to a machine to manage its extensions."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60">
            {extensions === null || extensions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {extensions === null
                  ? (loadError ?? "Loading extensions…")
                  : "No extensions in this profile yet."}
              </p>
            ) : (
              extensions.map((extension, index) => (
                <div
                  key={extension.id}
                  className={cn(
                    "flex items-start gap-3 px-3 py-2",
                    index > 0 && "border-t border-border/60",
                  )}
                >
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
                      <span className="truncate">{extension.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {extension.version}
                      </span>
                    </p>
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
                    <Button size="xs" variant="ghost" onClick={() => void remove(extension)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
        <BrowserExtensionInstallForm install={install} disabled={!canManage} />
      </div>
    </SettingsRow>
  );
}

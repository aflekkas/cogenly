import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useAppearancePreferences, writeAppearancePreferences } from "../appearancePreferences";
import { useTheme } from "../hooks/useTheme";
import {
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { toastManager } from "./ui/toast";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  clientPreferenceValues,
  clientSettingsPatchFromPreferences,
  planClientPreferenceSync,
  settleClientPreferenceWrite,
  type ClientPreferenceSyncBase,
} from "../sharedClientPreferences";

/** Keep first-paint and imperative client caches in step with universal settings. */
export function SharedClientPreferencesSync() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const environment =
    primary?.connection.phase === "connected" && primary.serverConfig !== null
      ? primary
      : environments.find(
          (item) => item.connection.phase === "connected" && item.serverConfig !== null,
        );
  const settings = environment?.serverConfig?.settings;
  const environmentId = environment?.environmentId ?? null;
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const client = useClientSettings();
  const hydrated = useClientSettingsHydrated();
  const { preferences } = useAppearancePreferences();
  const { appearanceMode, setAppearanceMode } = useTheme();
  const base = useRef<{ environmentId: typeof environmentId; values: ClientPreferenceSyncBase }>({
    environmentId,
    values: new Map(),
  });
  const destination = useRef(environmentId);
  const destinationGeneration = useRef(0);
  useLayoutEffect(() => {
    if (destination.current !== environmentId) {
      destination.current = environmentId;
      destinationGeneration.current += 1;
    }
  }, [environmentId]);
  const applyLocal = useCallback(
    (apply: ReturnType<typeof planClientPreferenceSync>["apply"]) => {
      const localPatch = clientSettingsPatchFromPreferences(apply);
      if (Object.keys(localPatch).length) void persistClientSettingsPatch(localPatch);
      const mode = apply.clientAppearanceMode;
      if (mode === "light" || mode === "dark" || mode === "system") setAppearanceMode(mode);
      const appearancePatch = {
        ...(apply.clientAppearanceAccent === undefined
          ? {}
          : { accent: apply.clientAppearanceAccent as typeof preferences.accent }),
        ...(apply.clientAppearanceFontSize === undefined
          ? {}
          : { fontSize: apply.clientAppearanceFontSize as typeof preferences.fontSize }),
        ...(apply.clientAppearanceMotion === undefined
          ? {}
          : { motion: apply.clientAppearanceMotion as typeof preferences.motion }),
        ...(apply.clientAppearanceUsageMeter === undefined
          ? {}
          : { usageMeter: apply.clientAppearanceUsageMeter as typeof preferences.usageMeter }),
      };
      if (Object.keys(appearancePatch).length) writeAppearancePreferences(appearancePatch);
    },
    [setAppearanceMode],
  );
  useEffect(() => {
    if (base.current.environmentId !== environmentId)
      base.current = { environmentId, values: new Map() };
    if (!settings || !hydrated || environmentId === null) return;
    const plan = planClientPreferenceSync(
      clientPreferenceValues(client, preferences, appearanceMode),
      settings,
      base.current.values,
    );
    base.current.values = plan.next;
    applyLocal(plan.apply);
    if (Object.keys(plan.patch).length) {
      const generation = destinationGeneration.current;
      void update({ environmentId, input: { patch: plan.patch } }).then((result) => {
        if (
          generation !== destinationGeneration.current ||
          destination.current !== environmentId ||
          base.current.environmentId !== environmentId
        )
          return;
        const settled = settleClientPreferenceWrite(
          base.current.values,
          plan.patch,
          result._tag === "Success" ? result.value : null,
          plan.next,
        );
        base.current.values = settled.next;
        applyLocal(settled.apply);
        if (settled.rejected)
          toastManager.add({
            type: "error",
            title: "Preferences not saved",
            description:
              "The machine could not save these preferences. Reconnect or update it, then try again.",
          });
      });
    }
  }, [appearanceMode, applyLocal, client, environmentId, hydrated, preferences, settings, update]);
  return null;
}

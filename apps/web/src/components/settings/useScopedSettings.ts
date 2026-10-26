import { AuthSettingsWriteScope } from "@cogenly/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@cogenly/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_SERVER_SETTINGS, type UnifiedSettings } from "@cogenly/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useMigrateModelPreferences,
} from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planScopedSettingsPatch,
  selectMachineLocalSettingsTargets,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target, merged with client settings. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  useMigrateModelPreferences(target?.environmentId ?? null, target?.settings ?? null);
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (plan: ReturnType<typeof planScopedSettingsPatch>) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return;
      }
      void persistScopedSettingsPatch(
        plan,
        async (request) => {
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
            (scope) => !readEnvironmentScope(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
        if (failedEnvironments.length === 0) return;
        toastManager.add({
          type: "error",
          title: savedEnvironmentCount > 0 ? "Setting saved on some machines" : "Setting not saved",
          description: [
            ...failedEnvironments.map(
              ({ label, message }) => `Could not save on ${label}: ${message}`,
            ),
            ...(savedEnvironmentCount > 0
              ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
              : []),
          ].join("\n"),
        });
      });
    },
    [persistServer],
  );
}

/** Universal keys reach every connected machine, so the plan sees all of them. */
export function useUpdateScopedSettings() {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => run(planScopedSettingsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

export function useScopedSettingsWriteAllowed(machineLocal = false) {
  const { scope, connectedEnvironments: scopedEnvironments } = useSettingsScope();
  const connectedEnvironments = machineLocal
    ? selectMachineLocalSettingsTargets(scope, scopedEnvironments)
    : scopedEnvironments;
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}

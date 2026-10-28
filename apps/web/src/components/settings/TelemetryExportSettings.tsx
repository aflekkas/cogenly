import { useAtomValue } from "@effect/atom-react";
import type { OtlpEndpointCheckResult, OtlpSignal } from "@cogenly/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsNote, SettingsRowContent, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsStatusBadge, type SettingsStatusTone } from "./SettingsStatus";

const SIGNALS = [
  { key: "otlpTracesUrl", label: "Traces", signal: "traces" },
  { key: "otlpMetricsUrl", label: "Metrics", signal: "metrics" },
  { key: "otlpLogsUrl", label: "Logs", signal: "logs" },
] as const;

type SignalKey = (typeof SIGNALS)[number]["key"];

/** The latest check for a signal; it describes the field only while `url` is still its value. */
type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function endpointStatus(
  url: string,
  check: EndpointCheck | undefined,
): { readonly label: string; readonly tone: SettingsStatusTone } {
  if (url === "") return { label: "Off", tone: "neutral" };
  if (check?.url !== url) return { label: "Not checked", tone: "info" };
  const { result } = check;
  if (result === null) return { label: "Checking…", tone: "neutral" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected · ${Math.round(result.latencyMs)} ms`, tone: "success" };
    case "Rejected":
      return { label: `Rejected · HTTP ${result.status}`, tone: "error" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", tone: "error" };
  }
}

export function TelemetryExportSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="OpenTelemetry export" id="telemetry-export">
        <SettingsScopeNotice target="environment">
          Choose one machine to configure its telemetry exports.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  // Mounts per environment so its saved endpoints are the ones checked on open.
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const environmentId = environment?.environmentId;
  // Checks need the same grant as saving, so one permission covers the whole form.
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  // Servers from before endpoint checks keep the editor without Test.
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  // Saved endpoints open as pending; the effect below sends their checks.
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>(() =>
    Object.fromEntries(
      SIGNALS.filter(({ key }) => isHttpUrl(saved[key])).map(({ key }) => [
        key,
        { url: saved[key], result: null },
      ]),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const changedSignals = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);
  const changed = changedSignals.length > 0;
  const running = environment?.serverConfig?.observability;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!environmentId) return;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    // A newer check for the same field replaces this one.
    setChecks((previous) => {
      if (previous[key]?.url !== url || previous[key].result !== null) return previous;
      const next = { ...previous };
      if (response._tag === "Success") next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!isHttpUrl(url)) return;
    setChecks((previous) => ({ ...previous, [key]: { url, result: null } }));
    void sendCheck(key, signal, url);
  };

  // Sends checks still pending, such as the saved endpoints' when the form opens.
  const sendPendingChecks = useEffectEvent(() => {
    for (const { key, signal } of SIGNALS) {
      const check = checks[key];
      if (check?.result === null) void sendCheck(key, signal, check.url);
    }
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) sendPendingChecks();
  }, [canCheck]);

  return (
    <SettingsSection
      title="OpenTelemetry export"
      id="telemetry-export"
      footer="Sends traces, metrics and logs to an OTLP HTTP receiver. Changes apply after a server restart, and environment variables override them."
    >
      {/* The rows sit inside the form, so it draws the card's row separators. */}
      <form
        className="divide-y divide-border/50"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!environment || saving) return;
          setSaving(true);
          try {
            const result = await updateSettings({
              environmentId: environment.environmentId,
              input: {
                patch: {
                  observability: Object.fromEntries(
                    changedSignals.map(({ key }) => [key, values[key]]),
                  ),
                },
              },
            });
            if (result._tag === "Success") {
              setDraft({});
              toastManager.add({
                type: "success",
                title: "Endpoints saved",
                description: "Restart the server to apply them.",
              });
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        {!canEdit && (
          <SettingsNote>
            This connection lacks permission to change settings on{" "}
            {environment?.label ?? "the selected machine"}.
          </SettingsNote>
        )}
        {SIGNALS.map(({ key, label, signal }) => {
          const url = values[key].trim();
          const status = canCheck ? endpointStatus(url, checks[key]) : null;
          return (
            <SettingsRowContent
              key={key}
              title={<label htmlFor={key}>{label} endpoint</label>}
              description={
                saved[key] !== (running?.[key] ?? "") ? (
                  <span className="break-all">Running: {running?.[key] || "Disabled"}</span>
                ) : undefined
              }
              control={
                status ? (
                  <SettingsStatusBadge tone={status.tone}>{status.label}</SettingsStatusBadge>
                ) : undefined
              }
            >
              <div className="flex gap-2 pt-2">
                <Input
                  id={key}
                  size="sm"
                  type="url"
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                  title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
                  placeholder={`http://localhost:4318/v1/${signal}`}
                  value={values[key]}
                  disabled={saving || !canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Restoring the saved value drops the draft, so a later save can't resend it
                    // over another client's change.
                    setDraft((previous) => {
                      const next = { ...previous, [key]: value };
                      if (value.trim() === saved[key]) delete next[key];
                      return next;
                    });
                  }}
                />
                {canCheck && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!isHttpUrl(url) || checks[key]?.result === null}
                    onClick={() => void checkEndpoint(key, signal, url)}
                  >
                    Test
                  </Button>
                )}
              </div>
            </SettingsRowContent>
          );
        })}
        {/* Save and Discard only exist while there is something to save or discard. */}
        <DisclosurePanel open={changed}>
          <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
            <p className="min-w-0 text-xs text-muted-foreground">Unsaved changes</p>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setDraft({});
                  // A tested draft replaced the saved endpoint's status; check the saved one again.
                  if (!canCheck) return;
                  for (const { key, signal } of SIGNALS) {
                    if (checks[key]?.url !== saved[key]) checkEndpoint(key, signal, saved[key]);
                  }
                }}
              >
                Discard
              </Button>
              <Button type="submit" size="sm" busy={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </DisclosurePanel>
      </form>
    </SettingsSection>
  );
}

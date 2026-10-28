import { squashAtomCommandFailure } from "@cogenly/client-runtime/state/runtime";
import {
  BrowserCookieImportInput,
  resolveBrowserProfiles,
  type BrowserCookieImportResult,
  type BrowserImportSource,
  type EnvironmentId,
} from "@cogenly/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkLogCollapse } from "../chat/WorkLog";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const decodeImportInput = Schema.decodeUnknownOption(BrowserCookieImportInput);

export function BrowserCookieImportSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return <CookieImportRow key={environmentId} environmentId={environmentId} />;
}

function CookieImportRow({ environmentId }: { environmentId: EnvironmentId | null }) {
  const canImport = useAtomValue(previewEnvironment.importCookies.permissionAtom(environmentId));
  const list = useAtomCommand(previewEnvironment.cookieSources);
  const clear = useAtomCommand(previewEnvironment.clearProfile);
  const run = useAtomCommand(previewEnvironment.importCookies, { reportFailure: false });
  const settings = useClientSettings();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<readonly BrowserImportSource[]>([]);
  const [sourceKey, setSourceKey] = useState("");
  const [domains, setDomains] = useState("");
  const [target, setTarget] = useState("default");
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BrowserCookieImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = sources.flatMap((source) =>
    source.profiles.map((profile) => ({
      key: JSON.stringify([source.id, profile.directory]),
      source,
      profile,
    })),
  );
  const selected = choices.find((choice) => choice.key === sourceKey);
  const invalidate = () => {
    setConfirmClear(false);
    setCleared(false);
    setReport(null);
    setError(null);
  };
  const importCookies = async (dryRun: boolean) => {
    if (!environmentId || !selected) return;
    const decoded = decodeImportInput({
      sourceId: selected.source.id,
      sourceProfileDirectory: selected.profile.directory,
      targetProfileId: target,
      dryRun,
      ...(domains.trim()
        ? {
            domains: domains
              .split(",")
              .map((domain) => domain.trim().replace(/^\./, "").toLowerCase()),
          }
        : {}),
    });
    if (decoded._tag === "None") {
      setError("Enter comma-separated domain names, such as github.com, linear.app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await run({ environmentId, input: decoded.value });
      if (result._tag === "Success") setReport(result.value);
      else {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure && typeof failure === "object" && "message" in failure
            ? String(failure.message)
            : "Could not import sign-ins. Check Keychain access or Full Disk Access for Safari, then retry.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      id="browser-cookie-import"
      title="Import sign-ins from another browser"
      description="Read cookies from browsers on the selected machine into its Cogenly browser. Nothing leaves that machine."
      control={
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          disabled={!canImport || busy}
          busy={!open && busy}
          onClick={async () => {
            if (open) {
              setOpen(false);
              return;
            }
            if (!environmentId) return;
            setBusy(true);
            try {
              const result = await list({ environmentId, input: {} });
              if (result._tag === "Success") {
                setSources(result.value);
                setOpen(true);
                invalidate();
                const first = result.value[0];
                setSourceKey(
                  first?.profiles[0] ? JSON.stringify([first.id, first.profiles[0].directory]) : "",
                );
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {open ? "Close" : busy ? "Finding browsers…" : "Import sign-ins"}
        </Button>
      }
    >
      <WorkLogCollapse open={open}>
        <div className="grid gap-3 py-3">
          <label className="grid gap-1 text-sm">
            Cogenly browser profile
            <Select
              value={target}
              onValueChange={(value) => {
                setTarget(value ?? "default");
                invalidate();
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label="Cogenly browser profile">
                <SelectValue>
                  {resolveBrowserProfiles(settings.browserProfiles).find(
                    (profile) => profile.id === target,
                  )?.name ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {resolveBrowserProfiles(settings.browserProfiles)
                  .filter((profile) => profile.kind === "persistent")
                  .map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </label>
          {choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No browser cookie stores found on this machine.
            </p>
          ) : (
            <>
              <label className="grid gap-1 text-sm">
                Source browser and profile
                <Select
                  value={sourceKey}
                  onValueChange={(value) => {
                    setSourceKey(value ?? "");
                    invalidate();
                  }}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="Source browser and profile">
                    <SelectValue>
                      {selected
                        ? `${selected.source.name} · ${selected.profile.name}`
                        : "Choose a browser"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((choice) => (
                      <SelectItem key={choice.key} value={choice.key}>
                        {choice.source.name} · {choice.profile.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>

              <label className="grid gap-1 text-sm">
                Domains (leave empty for all)
                <Input
                  placeholder="github.com, linear.app"
                  value={domains}
                  disabled={busy}
                  onChange={(event) => {
                    setDomains(event.target.value);
                    invalidate();
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                macOS may ask for Keychain access. Safari needs Cogenly (or the terminal running the
                server) enabled in System Settings → Privacy &amp; Security → Full Disk Access.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !canImport}
                  onClick={() => void importCookies(true)}
                >
                  Preview import
                </Button>
                <Button
                  size="sm"
                  disabled={!canImport || !report?.dryRun || report.available === 0}
                  busy={busy}
                  onClick={() => void importCookies(false)}
                >
                  {busy ? "Working…" : "Import"}
                </Button>
              </div>
            </>
          )}
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !canImport}
              onClick={() => setConfirmClear((value) => !value)}
            >
              Clear profile data
            </Button>
          </div>
          <WorkLogCollapse open={confirmClear}>
            <div className="space-y-2 text-sm">
              <p>Clear all cookies and site data in this Cogenly profile?</p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    if (!environmentId) return;
                    setBusy(true);
                    try {
                      const result = await clear({ environmentId, input: { profileId: target } });
                      if (result._tag === "Success") {
                        invalidate();
                        setReport(null);
                        setCleared(true);
                      }
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Confirm clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </WorkLogCollapse>
          <WorkLogCollapse open={cleared}>
            <p className="text-sm" role="status">
              Profile data cleared.
            </p>
          </WorkLogCollapse>
          <WorkLogCollapse open={report !== null || error !== null}>
            <div className="space-y-1 text-sm" role="status">
              {error && <p>{error}</p>}
              {report && (
                <>
                  <p>
                    {report.dryRun
                      ? `${report.available} cookies available`
                      : `${report.imported} cookies imported`}
                    ; {report.skipped} skipped.
                  </p>
                  {report.domains.map((domain) => (
                    <p key={domain.domain}>
                      {domain.domain}: {domain.count}
                    </p>
                  ))}
                  {report.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  {report.reloadRequired && (
                    <p>Reload browser tabs on this profile to use the sign-ins.</p>
                  )}
                </>
              )}
            </div>
          </WorkLogCollapse>
        </div>
      </WorkLogCollapse>
    </SettingsRow>
  );
}

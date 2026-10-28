import type { EnvironmentId, SourceControlProviderAuth } from "@cogenly/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { groupGitHubAccounts, nextGitHubHosts } from "./GitHubAccountSettings.logic";
import { readGitHubSettings } from "@cogenly/client-runtime/source-control-clients";
import { redactedPlaceholder } from "./RedactedSensitiveText";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsField, SettingsRowContent } from "./settingsLayout";

/** Sentinel select value for "follow gh's active login"; logins never contain spaces. */
const ACTIVE_ACCOUNT = "active gh account";

/**
 * A login, blurred like RedactedSensitiveText until the panel reveals it. Plain text, not a
 * button, so it can sit inside select options; one panel toggle reveals every login.
 */
function RedactedLogin(props: {
  readonly account: string;
  readonly revealed: boolean;
  /** Distinguishes hidden logins from each other for a screen reader, e.g. "Account 2". */
  readonly label?: string;
}) {
  return props.revealed ? (
    <span className="min-w-0 truncate font-mono text-2xs">{props.account}</span>
  ) : (
    <span className="min-w-0 truncate font-mono text-2xs">
      <span className="select-none blur-xs" aria-hidden>
        {redactedPlaceholder(props.account)}
      </span>
      <span className="sr-only">{props.label ?? "Hidden account"}</span>
    </span>
  );
}

/**
 * Per-host GitHub choices for one environment: turn a host off, or pin which of the
 * logins `gh` holds is used instead of its active one. Changes save immediately.
 */
export function GitHubAccountSettings({
  environmentId,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const github = useEnvironmentSettings(environmentId, readGitHubSettings);
  const hosts = github.hosts;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub account settings",
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const groups = groupGitHubAccounts(auth.accounts ?? []);

  const save = async (
    host: string,
    change: { readonly enabled?: boolean; readonly account?: string | null },
  ) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            sourceControlHosts: { github: { hosts: nextGitHubHosts(hosts, host, change) } },
          },
        },
      });
      if (result._tag === "Success") onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Sign in with <code className="rounded bg-muted px-1 py-px text-2xs">gh auth login</code> on
        the server host, then rescan to choose accounts here.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Choose which <code className="rounded bg-muted px-1 py-px text-2xs">gh</code> login each
          GitHub host uses, or turn a host off.
        </p>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? "Hide GitHub accounts" : "Reveal GitHub accounts"}
          aria-pressed={revealed}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      <SettingsGroup variant="inset">
        {groups.map((group) => {
          const choice = hosts[group.host];
          const enabled = choice?.enabled ?? true;
          const stalePin =
            choice?.account !== undefined && !group.selectable.includes(choice.account);
          const pinned =
            choice?.account !== undefined && !stalePin ? choice.account : ACTIVE_ACCOUNT;
          const hasDetails =
            group.selectable.length > 1 ||
            stalePin ||
            group.broken.length > 0 ||
            Boolean(group.environmentVariable);
          return (
            <SettingsRowContent
              key={group.host}
              title={group.host}
              description={
                group.selectable.length === 1 && group.selectable[0] !== undefined ? (
                  <span className="flex min-w-0 items-center gap-1">
                    <span>Signed in as</span>
                    <RedactedLogin revealed={revealed} account={group.selectable[0]} />
                  </span>
                ) : undefined
              }
              control={
                <Switch
                  checked={enabled}
                  disabled={saving}
                  aria-label={`Use GitHub on ${group.host}`}
                  onCheckedChange={(checked) => void save(group.host, { enabled: checked })}
                />
              }
            >
              {hasDetails ? (
                <div className="grid gap-2 pt-3">
                  {group.selectable.length > 1 ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">Account</span>
                      <SettingsField>
                        <Select
                          value={pinned}
                          disabled={saving || !enabled}
                          onValueChange={(value) => {
                            if (typeof value !== "string") return;
                            void save(group.host, {
                              account: value === ACTIVE_ACCOUNT ? null : value,
                            });
                          }}
                        >
                          <SelectTrigger size="sm" aria-label={`GitHub account for ${group.host}`}>
                            <SelectValue>
                              {(value: string) =>
                                value === ACTIVE_ACCOUNT ? (
                                  <span className="flex min-w-0 items-center gap-1">
                                    Active gh account
                                    {group.activeAccount ? (
                                      <>
                                        (
                                        <RedactedLogin
                                          revealed={revealed}
                                          account={group.activeAccount}
                                        />
                                        )
                                      </>
                                    ) : null}
                                  </span>
                                ) : (
                                  <RedactedLogin revealed={revealed} account={value} />
                                )
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem value={ACTIVE_ACCOUNT}>
                              <span className="flex min-w-0 items-center gap-1">
                                Active gh account
                                {group.activeAccount ? (
                                  <>
                                    (
                                    <RedactedLogin
                                      revealed={revealed}
                                      account={group.activeAccount}
                                    />
                                    )
                                  </>
                                ) : null}
                              </span>
                            </SelectItem>
                            {group.selectable.map((account, index) => (
                              <SelectItem key={account} value={account}>
                                <RedactedLogin
                                  revealed={revealed}
                                  account={account}
                                  label={`Account ${index + 1}`}
                                />
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </SettingsField>
                    </div>
                  ) : null}
                  {stalePin ? (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-warning">
                        The chosen login is no longer signed in, so the active gh login is used.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => void save(group.host, { account: null })}
                      >
                        Use active login
                      </Button>
                    </div>
                  ) : null}
                  {group.broken.map((entry) => (
                    <p
                      key={entry.account}
                      className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
                    >
                      <RedactedLogin revealed={revealed} account={entry.account} />
                      <span>
                        can't be used: {entry.error ?? "gh reports this login as invalid."}
                      </span>
                    </p>
                  ))}
                  {group.environmentVariable ? (
                    <p className="text-xs text-warning">
                      {group.environmentVariable} is set on the server, so it overrides the account
                      chosen here until it is unset.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </SettingsRowContent>
          );
        })}
      </SettingsGroup>
    </div>
  );
}

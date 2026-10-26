import {
  defaultVaultLoginLabel,
  vaultLoginHost,
  vaultLoginLabel,
  vaultLoginMissingUsername,
  type AgentId,
  type EnvironmentId,
  type IntegrationSummary,
  type VaultItemId,
  type VaultItemMetadata,
  type VaultUpdateInput,
  type VaultUsageEntry,
} from "@cogenly/contracts";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import { AnimatedHeight } from "../components/AnimatedHeight";
import { SiteFavicon } from "../components/SiteFavicon";
import {
  SettingsMasterDetail,
  SettingsMasterDetailAddRow,
  SettingsMasterDetailEditor,
  SettingsMasterDetailRow,
} from "../components/settings/SettingsMasterDetail";
import { SettingsEmpty, SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useVaultUsage } from "./useVault";
import { VaultAccessOptions } from "./VaultAccessOptions";
import { VaultUsageList } from "./VaultUsageList";
import { vaultLastUsedText, vaultPolicySummary, vaultPolicyWithAccess } from "./vault.logic";

const NO_WRITE_TITLE = "This connection cannot change the vault.";

/** A login's icon: its site's, as the server cached it, else a key. */
export function VaultLoginIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
}) {
  const host = vaultLoginHost(props.item);
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span className="size-4">
        {host ? (
          <SiteFavicon host={host} environmentId={props.environmentId} />
        ) : (
          <KeyRoundIcon className="size-4 text-muted-foreground" />
        )}
      </span>
    </span>
  );
}

/**
 * Settings → Vault → Logins: every saved sign-in like Integrations lists
 * accounts, the selected one's sites, access and history beside it.
 */
export function VaultLoginsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly logins: ReadonlyArray<VaultItemMetadata>;
  readonly lastUsed: ReadonlyMap<VaultItemId, VaultUsageEntry>;
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>;
  readonly integrations: ReadonlyArray<IntegrationSummary>;
  readonly canWrite: boolean;
  readonly onAdd: () => void;
  readonly onEdit: (item: VaultItemMetadata) => void;
  readonly onUpdate: (input: VaultUpdateInput) => Promise<VaultItemMetadata | null>;
  readonly onDelete: (item: VaultItemMetadata) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<VaultItemId | null>(null);
  const selected = props.logins.find((item) => item.id === selectedId) ?? props.logins[0] ?? null;
  const agentName = (id: AgentId) => props.agents.find((agent) => agent.id === id)?.name;
  return (
    <SettingsSection id="vault-logins" title="Logins" variant="plain">
      {props.logins.length === 0 ? (
        <SettingsEmpty
          icon={<KeyRoundIcon />}
          title="No logins yet"
          description="Sign-ins you save here, or on an agent's sign-in card, are filled by agents without them seeing the password."
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={!props.canWrite}
              title={props.canWrite ? undefined : NO_WRITE_TITLE}
              onClick={props.onAdd}
            >
              Add login
            </Button>
          }
        />
      ) : (
        <SettingsMasterDetail
          size="section"
          list={
            <>
              {props.logins.map((item) => (
                <VaultLoginRow
                  key={item.id}
                  environmentId={props.environmentId}
                  item={item}
                  lastUsed={vaultLastUsedText(
                    props.lastUsed.get(item.id),
                    agentName,
                    formatRelativeTimeLabel,
                  )}
                  selected={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
              <SettingsMasterDetailAddRow disabled={!props.canWrite} onClick={props.onAdd}>
                Add login
              </SettingsMasterDetailAddRow>
            </>
          }
          detail={
            selected ? (
              <SettingsMasterDetailEditor>
                <VaultLoginDetail
                  // Each login's inline edits are its own.
                  key={selected.id}
                  environmentId={props.environmentId}
                  item={selected}
                  agents={props.agents}
                  agentName={agentName}
                  integrations={props.integrations}
                  canWrite={props.canWrite}
                  onEdit={() => props.onEdit(selected)}
                  onUpdate={props.onUpdate}
                  onDelete={() => props.onDelete(selected)}
                />
              </SettingsMasterDetailEditor>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}

/** One login: its site, the username it signs in as, its label and its last use. */
function VaultLoginRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly lastUsed: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { item } = props;
  const label = vaultLoginLabel(item);
  // The default label only repeats the site and username, so it is not shown again.
  const customLabel = label === defaultVaultLoginLabel(item.name, item.username) ? null : label;
  return (
    <SettingsMasterDetailRow
      selected={props.selected}
      onSelect={props.onSelect}
      selectLabel={`Select ${label}`}
      icon={<VaultLoginIcon environmentId={props.environmentId} item={item} />}
      title={<span className="truncate text-sm font-medium text-foreground">{item.name}</span>}
      description={
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            {vaultLoginMissingUsername(item) ? (
              <Badge size="sm" variant="warning">
                Missing username
              </Badge>
            ) : (
              <span className="truncate">{item.username ?? "Username saved"}</span>
            )}
            {customLabel ? <span className="truncate">· {customLabel}</span> : null}
          </span>
          <span>{props.lastUsed}</span>
        </span>
      }
    />
  );
}

/** The selected login: who it signs in as, where, who may use it, and its history. */
function VaultLoginDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>;
  readonly agentName: (id: AgentId) => string | undefined;
  readonly integrations: ReadonlyArray<IntegrationSummary>;
  readonly canWrite: boolean;
  readonly onEdit: () => void;
  readonly onUpdate: (input: VaultUpdateInput) => Promise<VaultItemMetadata | null>;
  readonly onDelete: () => Promise<void>;
}) {
  const { item } = props;
  const idPrefix = useId();
  const [busy, setBusy] = useState(false);
  const usage = useVaultUsage(props.environmentId, item.id);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !props.canWrite;
  const linked = item.integrationIds ?? [];
  const integrationName = (id: string) => {
    const found = props.integrations.find((summary) => summary.integration.id === id);
    return found ? found.integration.displayName : "A removed integration";
  };
  const unlinked = props.integrations.filter((summary) => !linked.includes(summary.integration.id));
  const setLinks = (integrationIds: ReadonlyArray<string>) =>
    run(() => props.onUpdate({ id: item.id, integrationIds: [...integrationIds] }));
  return (
    <SettingsSection
      title={vaultLoginLabel(item)}
      icon={<VaultLoginIcon environmentId={props.environmentId} item={item} />}
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          disabled={disabled}
          aria-label={`Delete ${vaultLoginLabel(item)}`}
          title={props.canWrite ? "Delete" : NO_WRITE_TITLE}
          onClick={() => void run(props.onDelete)}
        >
          <Trash2Icon />
        </Button>
      }
    >
      <SettingsRow
        title="Username or email"
        description={
          vaultLoginMissingUsername(item)
            ? "Only the password is saved. Add the username or email so agents can sign in on their own."
            : (item.username ?? "Saved, too long to show")
        }
        control={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={props.onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="outline" disabled={disabled} onClick={props.onEdit}>
              Update password
            </Button>
          </div>
        }
      >
        {vaultLoginMissingUsername(item) ? (
          <AddUsername
            idPrefix={idPrefix}
            disabled={disabled}
            onSave={(username) =>
              run(() => props.onUpdate({ id: item.id, secretFields: { username } }))
            }
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Allowed sites"
        description={
          item.allowedDomains.length > 0
            ? [...item.allowedDomains, ...(item.policy.approvedDomains ?? [])].join(", ")
            : "None yet. Every fill asks you first."
        }
      />
      <SettingsRow title="Access" description={vaultPolicySummary(item.policy, props.agentName)}>
        <div className="pb-3">
          <VaultAccessOptions
            idPrefix={idPrefix}
            mode={item.policy.mode}
            agentIds={item.policy.allowedAgentIds}
            agents={props.agents}
            disabled={disabled}
            hideLabel
            onChange={(patch) =>
              void run(() =>
                props.onUpdate({ id: item.id, policy: vaultPolicyWithAccess(item.policy, patch) }),
              )
            }
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Signs in to"
        description={
          linked.length === 0
            ? "No integration. Agents link a login when an integration's setup signs in with it."
            : null
        }
        control={
          unlinked.length > 0 ? (
            <Select
              value=""
              disabled={disabled}
              onValueChange={(value) => {
                if (value) void setLinks([...linked, value]);
              }}
            >
              <SelectTrigger size="sm" aria-label="Link an integration">
                <SelectValue>Link integration</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {unlinked.map((summary) => (
                  <SelectItem key={summary.integration.id} value={summary.integration.id}>
                    {summary.integration.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null
        }
      >
        {linked.length > 0 ? (
          <ul className="flex flex-col gap-1 pb-3 text-sm">
            {linked.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span className="truncate">{integrationName(id)}</span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => void setLinks(linked.filter((other) => other !== id))}
                >
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      <SettingsRow title="History">
        <div className="pb-3 text-xs text-muted-foreground">
          {usage.error ? (
            <p className="text-destructive">{usage.error}</p>
          ) : !usage.isLoaded ? (
            <p>Loading history…</p>
          ) : usage.usage.length === 0 ? (
            <p>Not used yet.</p>
          ) : (
            <VaultUsageList
              environmentId={props.environmentId}
              usage={usage.usage}
              agentName={props.agentName}
            />
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/** "Add email": one field that saves the username into a password-only login. */
function AddUsername(props: {
  readonly idPrefix: string;
  readonly disabled: boolean;
  readonly onSave: (username: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <div className="pb-3">
      <AnimatedHeight>
        {open ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const username = value.trim();
              if (username) void props.onSave(username);
            }}
          >
            <Input
              id={`${props.idPrefix}-username`}
              aria-label="Username or email"
              autoFocus
              autoComplete="off"
              value={value}
              placeholder="you@example.com"
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <Button size="sm" type="submit" disabled={props.disabled || value.trim() === ""}>
              Save
            </Button>
          </form>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled}
            onClick={() => setOpen(true)}
          >
            Add email
          </Button>
        )}
      </AnimatedHeight>
    </div>
  );
}

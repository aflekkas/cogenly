import type { AgentId, EnvironmentId, VaultItemMetadata } from "@t3tools/contracts";
import { HistoryIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useAgents } from "../../agents/agentsClient";
import { requestConfirmDialog } from "../../confirmDialog";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useVaultActions, useVaultItems, useVaultUsage } from "../../vault/useVault";
import { VaultItemDialog } from "../../vault/VaultItemDialog";
import { VaultUsageList } from "../../vault/VaultUsageList";
import {
  lastUsedByItem,
  sortVaultItems,
  VAULT_TYPE_LABELS,
  vaultCreateInput,
  vaultPolicySummary,
  vaultUpdateInput,
} from "../../vault/vault.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { OverlayPresence } from "../ui/overlay-presence";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_WRITE_TITLE = "This connection cannot change the vault.";

type Editing = { readonly kind: "create" } | { readonly kind: "edit"; item: VaultItemMetadata };

/**
 * Settings → Vault. Logins, keys, cards and notes agents use without seeing,
 * who may use each one, and every recorded use. Follows the scope sentence's
 * environment, like Memory.
 */
export function VaultSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const sortedLabels = useMemo(
    () => sortProjectLabels(labels.map((label) => ({ label }))).map((entry) => entry.label),
    [labels],
  );
  const allAgents = useAgents().agents;
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.environmentId === environmentId),
    [allAgents, environmentId],
  );
  const list = useVaultItems(environmentId);
  const activity = useVaultUsage(environmentId);
  const actions = useVaultActions(environmentId, () => {
    list.refresh();
    activity.refresh();
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const items = useMemo(() => sortVaultItems(list.items), [list.items]);
  const lastUsed = useMemo(() => lastUsedByItem(activity.usage), [activity.usage]);
  const agentName = (id: AgentId) => agents.find((agent) => agent.id === id)?.name;
  const itemName = (id: string) => list.items.find((item) => item.id === id)?.name;
  const scopeName = (id: string | null) =>
    id === null ? null : (labels.find((label) => label.id === id)?.name ?? "A removed project");

  const addButton = (size: "xs" | "default") => (
    <Button
      size={size}
      variant={size === "xs" ? "ghost-muted" : "default"}
      disabled={!actions.canWrite}
      title={actions.canWrite ? undefined : NO_WRITE_TITLE}
      onClick={() => setEditing({ kind: "create" })}
    >
      <PlusIcon className={size === "xs" ? "size-3" : undefined} />
      Add item
    </Button>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="vault" title="Vault" headerAction={addButton("xs")}>
        {environmentId === null ? (
          <SettingsRow title="Choose a machine to see its vault." />
        ) : list.error !== null ? (
          <SettingsRow title="Could not load the vault" description={list.error} />
        ) : !list.isLoaded ? (
          <SettingsRow title="Loading vault…" />
        ) : items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing in the vault yet</EmptyTitle>
              <EmptyDescription>
                Store logins, API keys, cards and notes here so agents can use them without ever
                seeing them.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{addButton("default")}</EmptyContent>
          </Empty>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((item) => (
              <VaultItemRow
                key={item.id}
                environmentId={environmentId}
                item={item}
                scope={scopeName(item.scopeProjectId)}
                policy={vaultPolicySummary(item.policy, agentName)}
                lastUsedAt={lastUsed.get(item.id) ?? null}
                agentName={agentName}
                canWrite={actions.canWrite}
                onEdit={() => setEditing({ kind: "edit", item })}
                onDelete={async () => {
                  const message = `Delete “${item.name}”?\nAgents can no longer use it. Its usage log stays.`;
                  const confirmed =
                    (await requestConfirmDialog(message, { variant: "destructive" })) ??
                    window.confirm(message);
                  if (confirmed) await actions.remove(item.id);
                }}
              />
            ))}
          </ul>
        )}
      </SettingsSection>
      {environmentId !== null && items.length > 0 ? (
        <SettingsSection id="vault-activity" title="All activity">
          <div className="px-3 py-3 sm:px-4">
            <UsageBody
              error={activity.error}
              isLoaded={activity.isLoaded}
              empty={activity.usage.length === 0}
            >
              <VaultUsageList
                environmentId={environmentId}
                usage={activity.usage}
                agentName={agentName}
                itemName={itemName}
              />
            </UsageBody>
          </div>
        </SettingsSection>
      ) : null}
      <OverlayPresence when={editing}>
        {(current) => (
          <VaultItemDialog
            item={current.kind === "edit" ? current.item : null}
            defaultScopeProjectId={null}
            labels={sortedLabels}
            agents={agents}
            onClose={() => setEditing(null)}
            onSave={async (draft) => {
              const saved =
                current.kind === "edit"
                  ? await actions.update(vaultUpdateInput(current.item.id, draft))
                  : await actions.create(vaultCreateInput(draft));
              if (saved) setEditing(null);
            }}
          />
        )}
      </OverlayPresence>
    </SettingsPageContainer>
  );
}

function VaultItemRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly scope: string | null;
  readonly policy: string;
  readonly lastUsedAt: string | null;
  readonly agentName: (id: AgentId) => string | undefined;
  readonly canWrite: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => Promise<void>;
}) {
  const { item } = props;
  const [showUsage, setShowUsage] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = busy || !props.canWrite;
  const label = item.label ?? null;
  const cardLast4 = item.type === "card" && item.cardLast4 ? `•••• ${item.cardLast4}` : null;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className="truncate text-sm text-foreground">{item.name}</p>
          <Badge size="sm" variant="outline">
            {VAULT_TYPE_LABELS[item.type]}
          </Badge>
          {label ? <span className="truncate text-xs text-muted-foreground">{label}</span> : null}
          {cardLast4 ? (
            <span className="truncate text-xs text-muted-foreground">{cardLast4}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Edit ${item.name}`}
            title={props.canWrite ? "Edit" : NO_WRITE_TITLE}
            disabled={disabled}
            onClick={props.onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Delete ${item.name}`}
            title={props.canWrite ? "Delete" : NO_WRITE_TITLE}
            disabled={disabled}
            onClick={() => {
              setBusy(true);
              void props.onDelete().finally(() => setBusy(false));
            }}
          >
            <Trash2Icon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={showUsage ? "Hide usage" : "Show usage"}
            aria-expanded={showUsage}
            title="Usage"
            onClick={() => setShowUsage((open) => !open)}
          >
            <HistoryIcon />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span>{props.policy}</span>
        <span>· {props.scope ?? "All projects"}</span>
        {item.allowedDomains.length > 0 ? <span>· {item.allowedDomains.join(", ")}</span> : null}
        <span>
          ·{" "}
          {props.lastUsedAt
            ? `Last used ${formatRelativeTimeLabel(props.lastUsedAt)}`
            : "Never used"}
        </span>
      </div>
      {showUsage ? (
        <ItemUsage environmentId={props.environmentId} item={item} agentName={props.agentName} />
      ) : null}
    </li>
  );
}

function ItemUsage(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly agentName: (id: AgentId) => string | undefined;
}) {
  const usage = useVaultUsage(props.environmentId, props.item.id);
  return (
    <div className="reveal-motion ms-0.5 border-s border-border/70 ps-3 text-xs text-muted-foreground">
      <UsageBody error={usage.error} isLoaded={usage.isLoaded} empty={usage.usage.length === 0}>
        <VaultUsageList
          environmentId={props.environmentId}
          usage={usage.usage}
          agentName={props.agentName}
        />
      </UsageBody>
    </div>
  );
}

function UsageBody(props: {
  readonly error: string | null;
  readonly isLoaded: boolean;
  readonly empty: boolean;
  readonly children: ReactNode;
}) {
  if (props.error) return <p className="text-xs text-destructive">{props.error}</p>;
  if (!props.isLoaded) return <p className="text-xs text-muted-foreground">Loading usage…</p>;
  if (props.empty) return <p className="text-xs text-muted-foreground">Not used yet.</p>;
  return props.children;
}

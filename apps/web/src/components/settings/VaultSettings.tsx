import { matchesSettingsListQuery } from "./settingsList.logic";
import {
  SettingsList,
  SettingsListItem,
  SettingsListMeta,
  SettingsListToolbar,
  SettingsListSearch,
  SettingsListFilter,
  SettingsListEmpty,
} from "./SettingsList";
import {
  vaultLoginLabel,
  type AgentId,
  type EnvironmentId,
  type IntegrationSummary,
  type SharedSyncPeerStatus,
  type VaultItemMetadata,
  type VaultItemType,
  type VaultPeerSharing,
} from "@cogenly/contracts";
import { HistoryIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { useAgents } from "../../agents/agentsClient";
import { requestConfirmDialog } from "../../confirmDialog";
import {
  peerSyncIndicator,
  pendingFor,
  vaultItemsWaitingText,
  vaultPortabilityExplanation,
} from "../../machines/peerSync.logic";
import { useSyncPeers } from "../../machines/usePeerSync";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  useVaultActions,
  useVaultItems,
  useVaultSharing,
  useVaultUsage,
} from "../../vault/useVault";
import { VaultItemDialog } from "../../vault/VaultItemDialog";
import { VaultUsageList } from "../../vault/VaultUsageList";
import {
  lastUsedByItem,
  splitVaultItems,
  VAULT_TYPE_LABELS,
  VAULT_TYPES,
  vaultCreateInput,
  vaultItemDisplay,
  vaultLastUsedText,
  vaultPolicySummary,
  vaultUpdateInput,
} from "../../vault/vault.logic";
import { VaultLoginsSection } from "../../vault/VaultLogins";
import { integrationsRpc } from "../../rpc/integrations";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { OverlayPresence } from "../ui/overlay-presence";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PeerSyncRow } from "./PeerSyncRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsTag } from "./SettingsStatus";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionAction,
  SettingsNote,
} from "./settingsLayout";

const NO_WRITE_TITLE = "This connection cannot change the vault.";
const EMPTY_INTEGRATIONS: ReadonlyArray<IntegrationSummary> = [];

type Editing =
  | { readonly kind: "create"; readonly type: VaultItemType }
  | { readonly kind: "edit"; item: VaultItemMetadata };

const OTHER_TYPES = VAULT_TYPES.filter((type) => type !== "login");

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
  const syncPeers = useSyncPeers(environmentId, "vault");
  const actions = useVaultActions(environmentId, () => {
    list.refresh();
    activity.refresh();
    syncPeers.refresh();
  });
  const sharing = useVaultSharing(environmentId, syncPeers.refresh);
  // A standalone machine shows nothing about sharing: there is no one to share with.
  const paired = (sharing.status?.peers.length ?? 0) > 0 || syncPeers.peers.length > 0;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const { logins, others } = useMemo(() => splitVaultItems(list.items), [list.items]);
  const items = useMemo(
    () =>
      others.filter(
        (item) =>
          (type === "all" || item.type === type) &&
          matchesSettingsListQuery(query, [item.name, item.label, VAULT_TYPE_LABELS[item.type]]),
      ),
    [others, query, type],
  );
  const lastUsed = useMemo(() => lastUsedByItem(activity.usage), [activity.usage]);
  const integrationsQuery = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.list({ environmentId, input: {} }),
  );
  const integrations = integrationsQuery.data?.integrations ?? EMPTY_INTEGRATIONS;
  const confirmDelete = async (item: VaultItemMetadata) => {
    const message = `Delete “${item.type === "login" ? vaultLoginLabel(item) : vaultItemDisplay(item).title}”?\nAgents can no longer use it. Its usage log stays.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (confirmed) await actions.remove(item.id);
  };
  const agentName = (id: AgentId) => agents.find((agent) => agent.id === id)?.name;
  const itemName = (id: string) => {
    const item = list.items.find((entry) => entry.id === id);
    return item ? vaultItemDisplay(item).title : undefined;
  };
  const scopeName = (id: string | null) =>
    id === null ? null : (labels.find((label) => label.id === id)?.name ?? "A removed project");

  const filtered = query !== "" || type !== "all";
  // Search and filters only once there is something to narrow down.
  const showToolbar = list.isLoaded && (others.length > 0 || filtered);
  const addButton = () => (
    <Button
      size="xs"
      variant="outline"
      disabled={!actions.canWrite}
      title={actions.canWrite ? undefined : NO_WRITE_TITLE}
      onClick={() => setEditing({ kind: "create", type: "api_key" })}
    >
      <PlusIcon />
      Add item
    </Button>
  );

  return (
    <>
      {environmentId !== null && list.isLoaded && list.error === null ? (
        <VaultLoginsSection
          environmentId={environmentId}
          logins={logins}
          lastUsed={lastUsed}
          agents={agents}
          integrations={integrations}
          canWrite={actions.canWrite}
          onAdd={() => setEditing({ kind: "create", type: "login" })}
          onEdit={(item) => setEditing({ kind: "edit", item })}
          onUpdate={actions.update}
          onDelete={confirmDelete}
        />
      ) : null}
      <SettingsSection
        id="vault"
        title={environmentId !== null && list.isLoaded ? "Keys, cards and notes" : "Vault"}
        headerAction={
          <SettingsSectionAction
            disabled={!actions.canWrite}
            title={actions.canWrite ? undefined : NO_WRITE_TITLE}
            onClick={() => setEditing({ kind: "create", type: "api_key" })}
          >
            Add item
          </SettingsSectionAction>
        }
      >
        {environmentId !== null && showToolbar ? (
          <SettingsListToolbar>
            <SettingsListSearch label="Search vault" value={query} onValueChange={setQuery} />
            <SettingsListFilter
              label="Type"
              value={type}
              onValueChange={setType}
              options={[
                { value: "all", label: "All types" },
                ...OTHER_TYPES.map((value) => ({ value, label: VAULT_TYPE_LABELS[value] })),
              ]}
            />
          </SettingsListToolbar>
        ) : null}
        {environmentId === null ? (
          <SettingsRow title="Choose a machine to see its vault." />
        ) : list.error !== null ? (
          <SettingsRow title="Could not load the vault" description={list.error} />
        ) : !list.isLoaded ? (
          <SettingsRow title="Loading vault…" role="status" />
        ) : items.length === 0 ? (
          filtered ? (
            <SettingsListEmpty
              icon={<KeyRoundIcon />}
              label="No items match these filters."
              action={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setType("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <SettingsListEmpty
              icon={<KeyRoundIcon />}
              label="Store keys, cards and notes agents can use without seeing them."
              action={addButton()}
            />
          )
        ) : (
          <SettingsList>
            {items.map((item) => (
              <VaultItemRow
                key={item.id}
                environmentId={environmentId}
                item={item}
                scope={scopeName(item.scopeProjectId)}
                policy={vaultPolicySummary(item.policy, agentName)}
                lastUsed={vaultLastUsedText(
                  lastUsed.get(item.id),
                  agentName,
                  formatRelativeTimeLabel,
                )}
                agentName={agentName}
                canWrite={actions.canWrite}
                paired={paired}
                onEdit={() => setEditing({ kind: "edit", item })}
                onDelete={() => confirmDelete(item)}
              />
            ))}
          </SettingsList>
        )}
      </SettingsSection>
      {environmentId !== null && paired ? (
        <VaultSharingSection sharing={sharing} syncPeers={syncPeers.peers} />
      ) : null}
      {/* Each row already says "Never used", so an unused vault shows no activity card. */}
      {environmentId !== null && (activity.error || activity.usage.length > 0) ? (
        <SettingsSection id="vault-activity" title="Recent activity">
          {activity.error ? (
            <SettingsNote tone="destructive">{activity.error}</SettingsNote>
          ) : (
            <div className="px-3 py-3 sm:px-4">
              <VaultUsageList
                environmentId={environmentId}
                usage={activity.usage}
                agentName={agentName}
                itemName={itemName}
              />
            </div>
          )}
        </SettingsSection>
      ) : null}
      <OverlayPresence when={editing}>
        {(current) => (
          <VaultItemDialog
            item={current.kind === "edit" ? current.item : null}
            defaultScopeProjectId={null}
            {...(current.kind === "create" ? { defaultType: current.type } : {})}
            labels={sortedLabels}
            agents={agents}
            paired={paired}
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
    </>
  );
}

function VaultItemRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly scope: string | null;
  readonly policy: string;
  readonly lastUsed: string;
  readonly agentName: (id: AgentId) => string | undefined;
  readonly canWrite: boolean;
  readonly paired: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => Promise<void>;
}) {
  const { item } = props;
  const [showUsage, setShowUsage] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = busy || !props.canWrite;
  const display = vaultItemDisplay(item);
  const cardLast4 = item.type === "card" && item.cardLast4 ? `•••• ${item.cardLast4}` : null;
  const description = [display.description, cardLast4].filter(Boolean).join(" · ");
  return (
    <SettingsListItem
      title={display.title}
      description={description || undefined}
      status={
        <SettingsListMeta>
          <SettingsTag>{VAULT_TYPE_LABELS[item.type]}</SettingsTag>
          {display.internalName ? (
            // The generated name agents use for it: kept findable, never the headline.
            <span className="flex min-w-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  delay={300}
                  render={<span className="max-w-48 truncate font-mono" />}
                >
                  {display.internalName}
                </TooltipTrigger>
                <TooltipPopup side="top">{display.internalName}</TooltipPopup>
              </Tooltip>
              <CopyButton
                size="icon-micro"
                value={display.internalName}
                label="Copy item name"
                target="item name"
              />
            </span>
          ) : null}
          {props.paired && item.portability === "machine" ? (
            <Tooltip>
              <TooltipTrigger delay={300} render={<SettingsTag />}>
                This machine only
              </TooltipTrigger>
              <TooltipPopup side="top">
                {vaultPortabilityExplanation(item.portabilityReason)}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {props.policy}
          {/* Items work in every project unless limited to one; only the limit is news. */}
          {props.scope ? `Only in ${props.scope}` : null}
          {item.allowedDomains.length > 0 ? item.allowedDomains.join(", ") : null}
          {props.lastUsed}
        </SettingsListMeta>
      }
      control={
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Edit ${display.title}`}
            title={props.canWrite ? "Edit" : NO_WRITE_TITLE}
            disabled={disabled}
            onClick={props.onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={showUsage ? "Hide usage" : "Show usage"}
            aria-expanded={showUsage}
            title="Usage"
            onClick={() => setShowUsage((open) => !open)}
          >
            <HistoryIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Delete ${display.title}`}
            title={props.canWrite ? "Delete" : NO_WRITE_TITLE}
            disabled={disabled}
            onClick={() => {
              setBusy(true);
              void props.onDelete().finally(() => setBusy(false));
            }}
          >
            <Trash2Icon />
          </Button>
        </div>
      }
    >
      {showUsage ? (
        <ItemUsage environmentId={props.environmentId} item={item} agentName={props.agentName} />
      ) : null}
    </SettingsListItem>
  );
}

/**
 * Settings → Vault → Paired machines: each directly paired machine, how its
 * vault sharing stands, and the switch for this side of it. Only rendered while
 * the machine has someone to share with.
 */
function VaultSharingSection(props: {
  readonly sharing: ReturnType<typeof useVaultSharing>;
  readonly syncPeers: ReadonlyArray<SharedSyncPeerStatus>;
}) {
  const { sharing } = props;
  const waiting = vaultItemsWaitingText(sharing.status?.itemsWaiting ?? 0);
  return (
    <div className="space-y-2.5">
      <SettingsSection id="vault-machines" title="Paired machines">
        {!sharing.canRead ? (
          <SettingsRow
            title="Vault sharing"
            description="This connection can't see vault sharing. Reconnect with full access to manage it."
          />
        ) : sharing.status === null ? (
          sharing.error !== null ? (
            <SettingsRow title="Couldn't load vault sharing" description={sharing.error} />
          ) : (
            <SettingsRow title="Loading paired machines…" role="status" />
          )
        ) : (
          sharing.status.peers.map((peer) => (
            <VaultPeerRow
              key={peer.environmentId}
              peer={peer}
              pending={pendingFor(
                props.syncPeers.find((entry) => entry.environmentId === peer.environmentId),
                "vault",
              )}
              canWrite={sharing.canWrite}
              onShare={(enabled) => sharing.setPeerSharing(peer, enabled)}
            />
          ))
        )}
      </SettingsSection>
      <AnimatedHeight>
        {waiting ? <p className="px-3 text-xs text-muted-foreground sm:px-4">{waiting}</p> : null}
      </AnimatedHeight>
    </div>
  );
}

function VaultPeerRow(props: {
  readonly peer: VaultPeerSharing;
  readonly pending: number;
  readonly canWrite: boolean;
  readonly onShare: (enabled: boolean) => Promise<void>;
}) {
  const { peer } = props;
  const [busy, setBusy] = useState(false);
  const shared = peer.sharingEnabled ?? peer.state !== "not_shared";
  // Turning sharing on asks the other machine for its key, so it must be online.
  // Turning it off is local, and is what to do for a lost machine.
  const blockedOffline = !shared && !peer.online;
  const description = !props.canWrite
    ? "This connection can't change vault sharing."
    : blockedOffline
      ? `${peer.label} is offline. You can share once it's back.`
      : peer.state === "shared"
        ? `Shared with ${peer.label}`
        : "Not shared";
  return (
    <PeerSyncRow
      machine={peer.label}
      indicator={peerSyncIndicator({
        machine: peer.label,
        online: peer.online,
        pending: props.pending,
        sharing: peer.state,
      })}
      description={description}
    >
      <span className="text-xs text-muted-foreground">Share vault</span>
      <Switch
        checked={shared}
        disabled={!props.canWrite || busy || blockedOffline}
        aria-label={`Share vault with ${peer.label}`}
        onCheckedChange={(checked) => {
          setBusy(true);
          void props.onShare(checked).finally(() => setBusy(false));
        }}
      />
      {busy ? <Spinner /> : null}
    </PeerSyncRow>
  );
}

function ItemUsage(props: {
  readonly environmentId: EnvironmentId;
  readonly item: VaultItemMetadata;
  readonly agentName: (id: AgentId) => string | undefined;
}) {
  const usage = useVaultUsage(props.environmentId, props.item.id);
  return (
    <div className="reveal-motion ms-0.5 mt-2 mb-2 border-s border-border/70 ps-3 text-xs text-muted-foreground">
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

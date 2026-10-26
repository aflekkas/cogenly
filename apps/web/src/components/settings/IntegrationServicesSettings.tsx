import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  integrationIcon,
  vaultLoginLabel,
  type EnvironmentId,
  type IntegrationId,
  type IntegrationSummary,
} from "@cogenly/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { integrationSetupRequest, useConnectIntegration } from "~/hooks/useConnectIntegration";
import { useStartAgentChat } from "~/hooks/useStartAgentChat";
import { AnimatedHeight } from "~/components/AnimatedHeight";
import { cn } from "~/lib/utils";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { integrationsRpc } from "../../rpc/integrations";
import { useVaultItems } from "../../vault/useVault";
import { VaultLoginIcon } from "../../vault/VaultLogins";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { IntegrationSourceIcon } from "../chat/ComposerSourcesPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  integrationAccountLabel,
  integrationErrorText,
  integrationStatus,
  integrationTitle,
  scopeLabel,
  testResultReason,
  testResultToolsText,
  type IntegrationStatusView,
} from "./integrationServices.logic";
import { SettingsGroup } from "./SettingsGroup";
import {
  SettingsMasterDetail,
  SettingsMasterDetailAddRow,
  SettingsMasterDetailEditor,
  SettingsMasterDetailRow,
} from "./SettingsMasterDetail";
import { openSignInPage } from "./openIntegrationSignIn";
import { useStatusFade } from "./integrationStatusMotion";
import { useEnvironmentMachineList } from "../../machines/useMachines";
import { useOpenMachineHealthAlerts } from "../../machines/machineHealthAlertsStore";
import { integrationAttentionTone } from "./settingsAttention.logic";
import { SettingsAttentionTitle } from "./SettingsAttentionTitle";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsEmpty, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings lists connected accounts, like Providers lists agent CLIs. Agents own
 * discovery and setup: "Add integration" opens a chat where one connects the
 * service the user names.
 */
export function IntegrationServicesSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.list({ environmentId, input: {} }),
  );
  const canWrite = useAtomValue(integrationsRpc.update.permissionAtom(environmentId));
  const connect = useConnectIntegration(environmentId);
  const addDisabled = !canWrite || environmentId === null || connect.pending;
  const add = () => void connect.start(integrationSetupRequest(null));
  const integrations = query.data?.integrations ?? null;
  const [selectedId, setSelectedId] = useState<IntegrationId | null>(null);
  const selected =
    integrations?.find((summary) => summary.integration.id === selectedId) ??
    integrations?.[0] ??
    null;
  const addButton = (
    <Button size="xs" variant="outline" disabled={addDisabled} onClick={add}>
      <PlusIcon />
      Add integration
    </Button>
  );
  return (
    <SettingsSection {...searchableSetting("integration-services")} variant="plain">
      {environmentId === null ? (
        <SettingsGroup>
          <SettingsRow title="Choose a machine to see its integrations." />
        </SettingsGroup>
      ) : query.error !== null && integrations === null ? (
        <SettingsGroup>
          <SettingsRow title="Couldn't load integrations" description={query.error} />
        </SettingsGroup>
      ) : integrations === null ? (
        <SettingsGroup>
          <SettingsRow title="Loading integrations…" role="status" />
        </SettingsGroup>
      ) : integrations.length === 0 ? (
        <SettingsGroup>
          <SettingsEmpty label="No integrations yet." action={addButton} />
        </SettingsGroup>
      ) : (
        <SettingsMasterDetail
          size="section"
          list={
            <>
              {integrations.map((summary) => (
                <IntegrationListRow
                  key={summary.integration.id}
                  environmentId={environmentId}
                  summary={summary}
                  selected={summary.integration.id === selected?.integration.id}
                  onSelect={() => setSelectedId(summary.integration.id)}
                />
              ))}
              <SettingsMasterDetailAddRow disabled={addDisabled} onClick={add}>
                Add integration
              </SettingsMasterDetailAddRow>
            </>
          }
          detail={
            selected ? (
              <SettingsMasterDetailEditor>
                <IntegrationDetail
                  // Each account's errors and pending state are its own.
                  key={selected.integration.id}
                  environmentId={environmentId}
                  summary={selected}
                  onAgent={(prompt) =>
                    connect.start({
                      title: `Reconnect ${selected.integration.displayName}`,
                      prompt,
                    })
                  }
                />
              </SettingsMasterDetailEditor>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}

/** Healthy and off rows read fine from their text; only trouble gets a dot, as on Providers. */
function IntegrationStatusDot({ tone }: { readonly tone: IntegrationStatusView["tone"] }) {
  if (tone !== "warning" && tone !== "error") return null;
  return (
    <span className="flex h-[1.45em] shrink-0 items-center">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "error" ? "bg-destructive" : "bg-warning",
        )}
      />
    </span>
  );
}

/** One account in the list: the service, its account and status, and its on/off switch. */
function IntegrationListRow({
  environmentId,
  summary,
  selected,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: IntegrationSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { integration } = summary;
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const canWrite = useAtomValue(integrationsRpc.update.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const status = integrationStatus(summary, undefined);
  const statusRef = useStatusFade<HTMLSpanElement>(status.label);
  const icon = integrationIcon(integration);
  const account = integrationAccountLabel(integration);
  const attention = integrationAttentionTone(
    useOpenMachineHealthAlerts(),
    environmentId,
    integration.name,
  );
  const setEnabled = async (enabled: boolean) => {
    setPending(true);
    try {
      const result = await update({ environmentId, input: { id: integration.id, enabled } });
      if (result._tag !== "Success" && !isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: `Couldn't turn ${enabled ? "on" : "off"} ${integrationTitle(integration)}`,
          description: integrationErrorText(squashAtomCommandFailure(result)),
        });
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsMasterDetailRow
      selected={selected}
      dimmed={!integration.enabled}
      onSelect={onSelect}
      selectLabel={`Select ${integrationTitle(integration)}`}
      icon={
        <span className="flex size-5 shrink-0 items-center justify-center">
          <IntegrationSourceIcon {...icon} environmentId={environmentId} className="size-4" />
        </span>
      }
      title={
        <SettingsAttentionTitle tone={attention}>
          <span className="truncate text-sm font-medium text-foreground">
            {integration.displayName}
          </span>
        </SettingsAttentionTitle>
      }
      description={
        <>
          <IntegrationStatusDot tone={status.tone} />
          <span className="line-clamp-2 [overflow-wrap:anywhere]">
            <span ref={statusRef}>{status.label}</span>
            {account ? ` · ${account}` : null}
          </span>
        </>
      }
      trailing={
        <Switch
          checked={integration.enabled}
          disabled={pending || !canWrite}
          onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
          aria-label={`Turn on ${integrationTitle(integration)}`}
        />
      }
    />
  );
}

/** The selected account: its status and the projects it reaches, with what can be done to it. */
function IntegrationDetail({
  environmentId,
  summary,
  onAgent,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: IntegrationSummary;
  readonly onAgent: (prompt: string) => Promise<void>;
}) {
  const { integration } = summary;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  // Why an account stays on this machine only matters once there is another one.
  const peers =
    useEnvironmentMachineList(environmentId)?.machines.filter(
      (machine) => machine.pairing === "paired" && machine.environmentId !== environmentId,
    ) ?? [];
  const paired = peers.length > 0;
  const startAgentChat = useStartAgentChat();
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const remove = useOrchestrationCommand(integrationsRpc.remove, { reportFailure: false });
  const test = useOrchestrationCommand(integrationsRpc.testConnection, { reportFailure: false });
  const signIn = useOrchestrationCommand(integrationsRpc.beginSignIn, { reportFailure: false });
  const canWrite = useAtomValue(integrationsRpc.update.permissionAtom(environmentId));
  const canRemove = useAtomValue(integrationsRpc.remove.permissionAtom(environmentId));
  const canTest = useAtomValue(integrationsRpc.testConnection.permissionAtom(environmentId));
  const canSignIn = useAtomValue(integrationsRpc.beginSignIn.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = integrationStatus(summary, undefined);
  const statusRef = useStatusFade<HTMLSpanElement>(status.label);
  const icon = integrationIcon(integration);
  const report = (result: Awaited<ReturnType<typeof update>>) => {
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result))
      setError(integrationErrorText(squashAtomCommandFailure(result)));
    return false;
  };
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };
  const reconnect = async () => {
    if (
      !integration.enabled &&
      !report(await update({ environmentId, input: { id: integration.id, enabled: true } }))
    )
      return;
    if (!integration.auth && integration.transport !== "local") {
      await onAgent(
        `Reconnect my integration ${integration.name}. Read integration_setup_guide and verify it with integration_test.`,
      );
      return;
    }
    await openSignInPage(async () => {
      const result = await signIn({ environmentId, input: { id: integration.id } });
      if (result._tag === "Success") return result.value.authorizationUrl;
      if (!isAtomCommandInterrupted(result))
        setError(integrationErrorText(squashAtomCommandFailure(result)));
      return null;
    });
  };
  const runTest = async () => {
    const result = await test({ environmentId, input: { id: integration.id } });
    if (result._tag === "Success")
      toastManager.add(
        result.value.status === "connected"
          ? {
              type: "success",
              title: `Connected ${integrationTitle(integration)}`,
              description: testResultToolsText(result.value),
            }
          : {
              type: "error",
              title: `Couldn't connect ${integrationTitle(integration)}`,
              description: testResultReason(result.value),
            },
      );
    else if (!isAtomCommandInterrupted(result))
      setError(integrationErrorText(squashAtomCommandFailure(result)));
  };
  // An account that needs the user offers Reconnect first; a healthy one offers Test.
  const needsReconnect =
    status.tone === "warning" || status.tone === "error" || !integration.enabled;
  const reconnectDisabled = pending || !canWrite || !canSignIn;
  const testDisabled = pending || !canTest || !integration.enabled;
  const reconnectButton = (
    <Button
      size="sm"
      variant={needsReconnect ? "outline" : "ghost"}
      disabled={reconnectDisabled}
      onClick={() => void run(reconnect)}
    >
      Reconnect
    </Button>
  );
  const testButton = (
    <Button
      size="sm"
      variant={needsReconnect ? "ghost" : "outline"}
      disabled={testDisabled}
      onClick={() => void run(runTest)}
    >
      Test
    </Button>
  );
  return (
    <SettingsSection
      title={integrationTitle(integration)}
      icon={<IntegrationSourceIcon {...icon} environmentId={environmentId} className="size-4" />}
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          disabled={pending || !canRemove}
          aria-label={`Remove ${integrationTitle(integration)}`}
          onClick={() =>
            void run(async () => {
              if (
                !(await requestConfirmDialog(
                  `Remove ${integrationTitle(integration)}? Agents will no longer have access through this integration.`,
                ))
              )
                return;
              const result = await remove({ environmentId, input: { id: integration.id } });
              if (result._tag !== "Success" && !isAtomCommandInterrupted(result))
                setError(integrationErrorText(squashAtomCommandFailure(result)));
            })
          }
        >
          <Trash2Icon />
        </Button>
      }
    >
      <SettingsRow
        title="Status"
        description={
          <span className="flex min-w-0 items-baseline gap-1.5">
            <IntegrationStatusDot tone={status.tone} />
            <span ref={statusRef}>{status.label}</span>
            {status.toolCount !== null ? (
              <span>· {status.toolCount === 1 ? "1 tool" : `${status.toolCount} tools`}</span>
            ) : null}
          </span>
        }
        control={
          <div className="flex items-center justify-end gap-1">
            {needsReconnect ? (
              <>
                {testButton}
                {reconnectButton}
              </>
            ) : (
              <>
                {reconnectButton}
                {testButton}
              </>
            )}
          </div>
        }
      >
        <AnimatedHeight>
          {error || status.reason ? (
            <p role="status" className="pt-2 pb-2 text-sm text-destructive">
              {error ?? status.reason}
            </p>
          ) : null}
        </AnimatedHeight>
        {integration.setupNotes ? (
          <SetupNotes text={integration.setupNotes} updatedAt={integration.setupNotesUpdatedAt} />
        ) : null}
      </SettingsRow>
      <IntegrationSignInRow environmentId={environmentId} integrationId={integration.id} />
      <SettingsRow
        title="Projects"
        description={
          <>
            {scopeLabel(integration.scope, labels)}
            {paired && summary.notSyncedReason ? ` · ${summary.notSyncedReason}` : ""}
          </>
        }
        control={
          summary.notSyncedReason && paired ? (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {peers.map((machine) => (
                <Button
                  key={machine.environmentId}
                  size="sm"
                  variant="outline"
                  disabled={pending || !canWrite}
                  onClick={() =>
                    void run(async () => {
                      await startAgentChat(machine.environmentId, {
                        title: `Set up ${integration.displayName}`,
                        prompt: `Set up ${integration.displayName}${integration.accountLabel ? ` (${integration.accountLabel})` : ""} on this machine. It is already connected on another machine but its local runtime or endpoint cannot sync. Read integration_setup_guide, connect it here, include its logo, and verify it with integration_test.`,
                      });
                    })
                  }
                >
                  Set up on {machine.name}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}

/**
 * The vault logins an agent linked to this account while setting it up, e.g.
 * the Google account that owns its Cloud project. Shown only when there is one.
 */
function IntegrationSignInRow({
  environmentId,
  integrationId,
}: {
  readonly environmentId: EnvironmentId;
  readonly integrationId: IntegrationId;
}) {
  const logins = useVaultItems(environmentId).items.filter((item) =>
    item.integrationIds?.includes(integrationId),
  );
  if (logins.length === 0) return null;
  return (
    <SettingsRow
      title="Signs in with"
      description={
        <span className="flex flex-col gap-1">
          {logins.map((item) => (
            <span key={item.id} className="flex min-w-0 items-center gap-1.5">
              <VaultLoginIcon environmentId={environmentId} item={item} />
              <span className="truncate">
                {item.username ?? vaultLoginLabel(item)} <span>(vault)</span>
              </span>
            </span>
          ))}
        </span>
      }
    />
  );
}

/** What the agent that set this account up created, and where. */
function SetupNotes({
  text,
  updatedAt,
}: {
  readonly text: string;
  readonly updatedAt: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    // Set apart from the Status buttons above, like a section of its own.
    <div className="mt-2 border-t border-border/65 pt-2.5 pb-3">
      <DisclosureTrigger
        open={open}
        variant="quiet"
        className="w-fit"
        onClick={() => setOpen(!open)}
      >
        Setup notes
      </DisclosureTrigger>
      <DisclosurePanel open={open}>
        <p className="pt-1 text-sm whitespace-pre-wrap text-muted-foreground">{text}</p>
        {updatedAt ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Updated {new Date(updatedAt).toLocaleString()}
          </p>
        ) : null}
      </DisclosurePanel>
    </div>
  );
}

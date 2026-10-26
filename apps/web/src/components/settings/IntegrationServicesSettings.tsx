import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  INTEGRATION_CATALOG,
  integrationCatalogEntryFor,
  type EnvironmentId,
  type IntegrationNativeImportPreview,
  type IntegrationSummary,
} from "@cogenly/contracts";
import { MoreVertical } from "lucide-react";
import { useState } from "react";
import { useOpenAgentChat } from "~/hooks/useOpenAgentChat";
import { AnimatedHeight } from "~/components/AnimatedHeight";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { integrationsRpc } from "../../rpc/integrations";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { IntegrationSourceIcon } from "../chat/ComposerSourcesPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  integrationErrorText,
  integrationStatus,
  integrationTitle,
  scopeLabel,
} from "./integrationServices.logic";
import {
  NATIVE_IMPORT_STATUS_TEXT,
  nativeImportReview,
  type NativeImportReview,
} from "./nativeImportReview.logic";
import { openSignInPage } from "./openIntegrationSignIn";
import { useStatusFade } from "./integrationStatusMotion";
import { useEnvironmentMachineList } from "../../machines/useMachines";
import { useOpenMachineHealthAlerts } from "../../machines/machineHealthAlertsStore";
import { integrationAttentionTone } from "./settingsAttention.logic";
import { SettingsAttentionTitle } from "./SettingsAttentionTitle";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Opens a new chat on the selected environment, preserving existing drafts. */
function useConnectWithAgent(environmentId: EnvironmentId | null) {
  const openAgentChat = useOpenAgentChat();
  const [pending, setPending] = useState(false);
  return {
    pending,
    // Left open for the service's name; a suggested service fills it in.
    connect: async (request = "Connect ") => {
      if (environmentId === null || pending) return;
      setPending(true);
      try {
        await openAgentChat(environmentId, request);
      } finally {
        setPending(false);
      }
    },
  };
}

/** Settings manages connected accounts. Agents own discovery and setup. */
export function IntegrationServicesSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.list({ environmentId, input: {} }),
  );
  const canWrite = useAtomValue(integrationsRpc.update.permissionAtom(environmentId));
  const agent = useConnectWithAgent(environmentId);
  const connectDisabled = !canWrite || environmentId === null || agent.pending;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const integrations = query.data?.integrations ?? null;
  // Quick starts skip services that are already connected.
  const connectedCatalogIds = new Set(
    (integrations ?? []).flatMap(
      (summary) => integrationCatalogEntryFor(summary.integration)?.id ?? [],
    ),
  );
  const suggestions = INTEGRATION_CATALOG.filter((entry) => !connectedCatalogIds.has(entry.id));
  const empty = integrations !== null && integrations.length === 0;
  return (
    <SettingsSection {...searchableSetting("integration-services")}>
      {/* The one-time import leads the card so it is seen before the account list. */}
      <AnimatedHeight>
        {!settings.nativeMcpImportReviewed && !settings.useProviderConnectors ? (
          <NativeImportOffer
            key={environmentId ?? "none"}
            environmentId={environmentId}
            onAgent={agent.connect}
            onDone={() => updateSettings({ nativeMcpImportReviewed: true })}
          />
        ) : null}
      </AnimatedHeight>
      {environmentId === null ? (
        <SettingsRow title="Choose a machine to see its integrations." />
      ) : query.error !== null && integrations === null ? (
        <SettingsRow title="Couldn't load integrations" description={query.error} />
      ) : integrations === null ? (
        <SettingsRow title="Loading integrations…" role="status" />
      ) : (
        integrations.map((summary) => (
          <AccountRow
            key={summary.integration.id}
            environmentId={environmentId}
            summary={summary}
            onAgent={agent.connect}
          />
        ))
      )}
      {integrations !== null ? (
        <SettingsRow
          {...searchableSetting("integration-add")}
          {...(empty ? { title: "Connect your first service" } : {})}
          description={
            empty
              ? "Let agents read and act in services like Gmail, Slack and Linear. An agent sets each one up with you and asks before it uses a sign-in or secret."
              : "Ask an agent to connect another service or any MCP server. It walks you through setup."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={connectDisabled}
              onClick={() => void agent.connect()}
            >
              Connect with an agent
            </Button>
          }
        >
          {suggestions.length > 0 ? (
            <div
              role="group"
              aria-label="Suggested services"
              className="flex flex-wrap gap-2 pt-2 pb-3"
            >
              {suggestions.map((entry) => (
                <Button
                  key={entry.id}
                  size="sm"
                  variant="outline"
                  disabled={connectDisabled}
                  onClick={() => void agent.connect(`Connect ${entry.name}`)}
                >
                  <IntegrationSourceIcon icon={entry.icon} />
                  {entry.name}
                </Button>
              ))}
            </div>
          ) : null}
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}

const REVIEW_WITH_AGENT_REQUEST =
  "Help me finish importing my Claude and Codex integrations into Cogenly. Tell me what couldn't be reviewed, then set up the ones I choose.";

/** Whether agents also load the MCP servers, connectors and plugins set up in Claude or Codex. */
export function UseOnlyCogenlyIntegrationsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("provider-connectors")}
      description="Agents skip the MCP servers, connectors and plugins set up in Claude or Codex. Servers checked into a repo, like its .mcp.json, and ones your organization manages still load. Applies to new agent sessions."
      settingKeys={["useProviderConnectors"]}
      control={
        <Switch
          checked={!settings.useProviderConnectors}
          onCheckedChange={(checked) => updateSettings({ useProviderConnectors: !checked })}
          aria-label="Use only Cogenly integrations"
        />
      }
    />
  );
}

/**
 * The one-time offer to bring native Claude and Codex servers into Cogenly. Review loads what
 * was found into a short grouped list; Import or Skip settles the offer. The per-field detail an
 * agent needs to finish setup stays in `integration_native_preview`, not here.
 */
function NativeImportOffer({
  environmentId,
  onAgent,
  onDone,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly onAgent: (request: string) => Promise<void>;
  readonly onDone: () => void;
}) {
  const preview = useOrchestrationCommand(integrationsRpc.previewNative, { reportFailure: false });
  const importNative = useOrchestrationCommand(integrationsRpc.importNative, {
    reportFailure: false,
  });
  const canImport = useAtomValue(integrationsRpc.importNative.permissionAtom(environmentId));
  const [offer, setOffer] = useState<IntegrationNativeImportPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = offer === null ? null : nativeImportReview(offer.servers ?? []);
  const found = review === null ? 0 : review.count || (offer?.definitions.length ?? 0);
  const run = async (action: (environmentId: EnvironmentId) => Promise<void>) => {
    if (environmentId === null) return;
    setPending(true);
    setError(null);
    try {
      await action(environmentId);
    } finally {
      setPending(false);
    }
  };
  const load = (environmentId: EnvironmentId) =>
    preview({ environmentId, input: {} }).then((result) => {
      if (result._tag === "Success") {
        setOffer(result.value);
        setIncomplete(result.value.incomplete === true);
        setOpen(true);
      } else if (!isAtomCommandInterrupted(result))
        setError(integrationErrorText(squashAtomCommandFailure(result)));
    });
  const accept = (environmentId: EnvironmentId) =>
    importNative({ environmentId, input: {} }).then((result) => {
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result))
          setError(integrationErrorText(squashAtomCommandFailure(result)));
        return;
      }
      // Whatever was imported stays; the offer stays open until the rest is reviewed or skipped.
      if (result.value.incomplete) setIncomplete(true);
      else onDone();
    });
  return (
    <SettingsRow
      title="Import from Claude and Codex"
      description={
        review === null
          ? "Bring the MCP servers you set up in Claude and Codex into Cogenly. Agents keep using them until you import or skip."
          : found === 0
            ? "No servers found in your Claude or Codex settings."
            : `Found ${found === 1 ? "1 server" : `${found} servers`} in Claude and Codex. Each stays off until an agent finishes setting it up with you.`
      }
      control={
        <div className="flex gap-2">
          {review === null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !canImport || environmentId === null}
              onClick={() => void run(load)}
            >
              Review
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={pending || !canImport || environmentId === null}
              onClick={() => void run(accept)}
            >
              Import
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={pending || !canImport} onClick={onDone}>
            Skip
          </Button>
        </div>
      }
    >
      {review !== null && review.count > 0 ? (
        <div className="pb-3">
          <DisclosureTrigger
            open={open}
            variant="quiet"
            className="w-fit"
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide servers" : "Show servers"}
          </DisclosureTrigger>
          <DisclosurePanel open={open} appear>
            <NativeImportList review={review} />
          </DisclosurePanel>
        </div>
      ) : null}
      <AnimatedHeight>
        {incomplete ? (
          <div role="status" className="flex flex-wrap items-center gap-2 pb-3 text-sm">
            <p className="min-w-0 flex-1 text-muted-foreground">
              Some settings couldn't be read, so this list may be missing servers. An agent can
              check them with you, or you can skip the import.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void onAgent(REVIEW_WITH_AGENT_REQUEST)}
            >
              Ask an agent
            </Button>
          </div>
        ) : null}
      </AnimatedHeight>
      <AnimatedHeight>
        {error ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </AnimatedHeight>
    </SettingsRow>
  );
}

const STATUS_BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  neutral: "secondary",
} as const;

/** The review's servers, grouped by provider and capped in height so the page stays short. */
function NativeImportList({ review }: { readonly review: NativeImportReview }) {
  return (
    <div className="mt-2 max-h-72 space-y-3 overflow-y-auto">
      {review.groups.map((group) => (
        <section key={group.provider} aria-label={group.title}>
          <h4 className="pb-1 font-medium text-muted-foreground text-xs">{group.title}</h4>
          <ul>
            {group.rows.map((row) => {
              const status = NATIVE_IMPORT_STATUS_TEXT[row.status];
              return (
                <li key={row.key} className="flex min-w-0 items-center gap-2 py-1">
                  <IntegrationSourceIcon icon={row.icon} className="size-4 shrink-0" />
                  <span className="shrink-0 text-sm">{row.label}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                    {row.source}
                  </span>
                  <Badge variant={STATUS_BADGE_VARIANT[status.tone]}>{status.label}</Badge>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AccountRow({
  environmentId,
  summary,
  onAgent,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: IntegrationSummary;
  readonly onAgent: (request: string) => Promise<void>;
}) {
  const { integration } = summary;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  // Why an account stays on this machine only matters once there is another one.
  const paired =
    useEnvironmentMachineList(environmentId)?.machines.some(
      (machine) => machine.pairing === "paired",
    ) ?? false;
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
  const entry = integrationCatalogEntryFor(integration);
  const attention = integrationAttentionTone(
    useOpenMachineHealthAlerts(),
    environmentId,
    integration.name,
  );
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
      toastManager.add({
        type: result.value.status === "connected" ? "success" : "error",
        title: result.value.message,
      });
    else if (!isAtomCommandInterrupted(result))
      setError(integrationErrorText(squashAtomCommandFailure(result)));
  };
  // A row that needs the user offers Reconnect; a healthy one offers Test.
  // The other action, Turn off and Remove sit in the row's menu.
  const needsReconnect =
    status.tone === "warning" || status.tone === "error" || !integration.enabled;
  const reconnectDisabled = pending || !canWrite || !canSignIn;
  const testDisabled = pending || !canTest || !integration.enabled;
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <IntegrationSourceIcon icon={entry?.icon ?? null} />
          <SettingsAttentionTitle tone={attention}>
            <span>{integrationTitle(integration)}</span>
          </SettingsAttentionTitle>
        </span>
      }
      description={
        <>
          <span ref={statusRef}>{status.label}</span>
          {/* The title already names the account. */}
          {` · ${scopeLabel(integration.scope, labels)}`}
          {paired && summary.notSyncedReason ? ` · ${summary.notSyncedReason}` : ""}
        </>
      }
      control={
        <div className="flex items-center justify-end gap-1">
          {needsReconnect ? (
            <Button
              size="sm"
              variant="outline"
              disabled={reconnectDisabled}
              onClick={() => void run(reconnect)}
            >
              Reconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={testDisabled}
              onClick={() => void run(runTest)}
            >
              Test
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={pending}
                  aria-label={`${integrationTitle(integration)} options`}
                />
              }
            >
              <MoreVertical />
            </MenuTrigger>
            <MenuPopup align="end">
              {needsReconnect ? (
                <MenuItem disabled={testDisabled} onClick={() => void run(runTest)}>
                  Test connection
                </MenuItem>
              ) : (
                <MenuItem disabled={reconnectDisabled} onClick={() => void run(reconnect)}>
                  Reconnect
                </MenuItem>
              )}
              {integration.enabled ? (
                <MenuItem
                  disabled={!canWrite}
                  onClick={() =>
                    void run(async () => {
                      report(
                        await update({
                          environmentId,
                          input: { id: integration.id, enabled: false },
                        }),
                      );
                    })
                  }
                >
                  Turn off
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!canRemove}
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
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      <AnimatedHeight>
        {error || status.reason ? (
          <p role="status" className="pb-2 text-sm text-destructive">
            {error ?? status.reason}
          </p>
        ) : null}
      </AnimatedHeight>
    </SettingsRow>
  );
}

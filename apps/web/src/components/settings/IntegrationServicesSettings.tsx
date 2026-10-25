import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  integrationCatalogEntryFor,
  type EnvironmentId,
  type IntegrationSummary,
} from "@t3tools/contracts";
import { useState } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { AnimatedHeight } from "~/components/AnimatedHeight";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { integrationsRpc } from "../../rpc/integrations";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { IntegrationSourceIcon } from "../chat/ComposerSourcesPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  integrationErrorText,
  integrationStatus,
  integrationTitle,
  scopeLabel,
} from "./integrationServices.logic";
import { openSignInPage } from "./openIntegrationSignIn";
import { useStatusFade } from "./integrationStatusMotion";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Opens a new chat on the selected environment, preserving existing drafts. */
function useConnectWithAgent(environmentId: EnvironmentId | null) {
  const { openScratchProject } = useScratchProject();
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);
  return {
    pending,
    connect: async (
      request = "Help me connect an integration. Read integration_setup_guide and do the setup for me.",
    ) => {
      if (environmentId === null || pending) return;
      setPending(true);
      try {
        const project = await openScratchProject(environmentId);
        if (!project) return;
        const opened = await newThread(scopeProjectRef(environmentId, project.id), {
          surface: "chat",
        });
        if (opened) useComposerDraftStore.getState().setPrompt(opened.draftId, request);
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
  return (
    <>
      <SettingsSection {...searchableSetting("integration-services")}>
        {environmentId === null ? (
          <SettingsRow title="Choose an environment to see its integrations." />
        ) : query.error !== null && query.data === null ? (
          <SettingsRow title="Couldn't load integrations" description={query.error} />
        ) : query.data === null ? (
          <SettingsRow title="Loading integrations…" role="status" />
        ) : (
          query.data.integrations.map((summary) => (
            <AccountRow
              key={summary.integration.id}
              environmentId={environmentId}
              summary={summary}
              onAgent={agent.connect}
            />
          ))
        )}
        <SettingsRow
          {...searchableSetting("integration-add")}
          description="Ask an agent to connect Gmail, Wispr Flow, or any MCP server. It handles setup and asks you for consent or secrets when needed."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || environmentId === null || agent.pending}
              onClick={() => void agent.connect()}
            >
              Connect with an agent
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Provider connectors" hideTitle>
        <ProviderConnectorsSettingRow key={environmentId ?? "none"} environmentId={environmentId} />
      </SettingsSection>
    </>
  );
}

function ProviderConnectorsSettingRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const preview = useOrchestrationCommand(integrationsRpc.previewNative, { reportFailure: false });
  const importNative = useOrchestrationCommand(integrationsRpc.importNative, {
    reportFailure: false,
  });
  const canImport = useAtomValue(integrationsRpc.importNative.permissionAtom(environmentId));
  const [offer, setOffer] = useState<
    import("@t3tools/contracts").IntegrationNativeImportPreview | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = async (accept: boolean) => {
    if (environmentId === null) return;
    setPending(true);
    setError(null);
    try {
      if (accept) {
        const result = await importNative({ environmentId, input: {} });
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result))
            setError(integrationErrorText(squashAtomCommandFailure(result)));
          return;
        }
        if (result.value.incomplete) {
          setOffer((current) => ({
            definitions: current?.definitions ?? [],
            reconnect: result.value.reconnect,
            warnings: result.value.warnings,
            incomplete: true,
          }));
          setError(
            "Some native sources could not be reviewed. Resolve the warnings and try again, or explicitly skip the import.",
          );
          return;
        }
      }
      updateSettings({ nativeMcpImportReviewed: true });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <AnimatedHeight>
        {!settings.nativeMcpImportReviewed && !settings.useProviderConnectors ? (
          <SettingsRow
            title="Review your native integrations first"
            description="Native servers stay available until you import their definitions or skip this offer. Imported connections stay disconnected until an agent collects secrets and verifies them."
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !canImport || environmentId === null}
                  onClick={() =>
                    void (async () => {
                      if (environmentId === null) return;
                      setPending(true);
                      try {
                        const result = await preview({ environmentId, input: {} });
                        if (result._tag === "Success") setOffer(result.value);
                        else if (!isAtomCommandInterrupted(result))
                          setError(integrationErrorText(squashAtomCommandFailure(result)));
                      } finally {
                        setPending(false);
                      }
                    })()
                  }
                >
                  Review import
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || !canImport}
                  onClick={() => void review(false)}
                >
                  Skip import
                </Button>
              </div>
            }
          >
            <AnimatedHeight>
              {offer ? (
                <div className="space-y-2 pb-3 text-sm">
                  <p>
                    {offer.definitions.length
                      ? offer.definitions.map((definition) => definition.name).join(", ")
                      : offer.incomplete
                        ? "Native source review is incomplete."
                        : "No native definitions found."}
                  </p>
                  {offer.reconnect.map((name) => (
                    <p key={name}>{name}: reconnect with an agent</p>
                  ))}
                  {offer.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  <Button
                    size="sm"
                    disabled={pending || !canImport}
                    onClick={() => void review(true)}
                  >
                    Import definitions and continue
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
        ) : null}
      </AnimatedHeight>

      <SettingsRow
        serverScoped
        {...searchableSetting("provider-connectors")}
        description="Agents use Cogenly's integrations instead of the provider's native MCP servers and apps. Turn off to restore native configuration. Applies to new provider sessions; Muse and administrator-managed Claude servers may remain available."
        settingKeys={["useProviderConnectors"]}
        control={
          <ScopedSwitch
            settingKeys={["useProviderConnectors"]}
            checked={!settings.useProviderConnectors}
            onCheckedChange={(checked) => updateSettings({ useProviderConnectors: !checked })}
            aria-label="Use only Cogenly integrations"
          />
        }
      />
    </>
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
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <IntegrationSourceIcon icon={entry?.icon ?? null} />
          <span>{integrationTitle(integration)}</span>
        </span>
      }
      description={
        <>
          <span ref={statusRef}>{status.label}</span>
          {` · ${scopeLabel(integration.scope, labels)}`}
          {integration.accountLabel ? ` · ${integration.accountLabel}` : ""}
        </>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !canTest || !integration.enabled}
            onClick={() =>
              void run(async () => {
                const result = await test({ environmentId, input: { id: integration.id } });
                if (result._tag === "Success")
                  toastManager.add({
                    type: result.value.status === "connected" ? "success" : "error",
                    title: result.value.message,
                  });
                else if (!isAtomCommandInterrupted(result))
                  setError(integrationErrorText(squashAtomCommandFailure(result)));
              })
            }
          >
            Test
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !canWrite || !canSignIn}
            onClick={() => void run(reconnect)}
          >
            Reconnect
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !canWrite || !integration.enabled}
            onClick={() =>
              void run(async () => {
                report(
                  await update({ environmentId, input: { id: integration.id, enabled: false } }),
                );
              })
            }
          >
            Disconnect
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !canRemove}
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
          </Button>
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

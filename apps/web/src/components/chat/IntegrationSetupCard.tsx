import {
  integrationCatalogEntryFor,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@cogenly/contracts";
import type { SecretRequestItem } from "@cogenly/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { CheckIcon, PlugIcon } from "lucide-react";
import { integrationsRpc } from "../../rpc/integrations";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { integrationErrorText } from "../settings/integrationServices.logic";
import { openSignInPage } from "../settings/openIntegrationSignIn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { IntegrationSourceIcon } from "./ComposerSourcesPicker";
import { ThreadPromptCard } from "./ThreadPromptCard";
import { WorkLogCollapse, WorkLogRow } from "./WorkLog";

/** The card reads the destination environment, including after consent in an external browser. */
export function IntegrationSetupCard({
  environmentId,
  item,
  visibility,
  onToggle,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly onToggle?: (collapsed: boolean) => void;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const query = useEnvironmentQuery(integrationsRpc.list({ environmentId, input: {} }));
  const target = item.integrationSetup;
  const summary = query.data?.integrations.find((summary) =>
    target?.integrationId
      ? summary.integration.id === target.integrationId
      : integrationCatalogEntryFor(summary.integration)?.id === target?.setup?.catalogId &&
        summary.integration.accountLabel === target?.accountLabel,
  );
  const setup = summary?.setup ?? target?.setup;
  const catalogId = setup?.catalogId;
  const saveKey = useOrchestrationCommand(integrationsRpc.saveApiKey, { reportFailure: false });
  const saveClient = useOrchestrationCommand(integrationsRpc.saveOAuthClient, {
    reportFailure: false,
  });
  const install = useOrchestrationCommand(integrationsRpc.installRuntime, { reportFailure: false });
  const signIn = useOrchestrationCommand(integrationsRpc.beginSignIn, { reportFailure: false });
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const canSignIn = useAtomValue(integrationsRpc.beginSignIn.permissionAtom(environmentId));
  const canUpdate = useAtomValue(integrationsRpc.update.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A "fix" step names a field, so its editor starts open.
  const [editing, setEditing] = useState(target?.setup?.type === "fix");
  const [url, setUrl] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [credential, setCredential] = useState("");
  const [scope, setScope] = useState<string | null>(null);
  const edit = (open: boolean) => {
    onToggle?.(!open);
    setEditing(open);
  };
  const connected = summary?.status === "connected";
  if (item.secretStatus !== "pending" || connected || visibility !== "local")
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={
          connected || item.secretStatus === "saved" ? (
            <CheckIcon className="size-3.5 text-icon-muted" aria-hidden />
          ) : (
            <PlugIcon className="size-3.5 text-icon-muted" aria-hidden />
          )
        }
        label={`${item.label} · ${connected || item.secretStatus === "saved" ? "Connected" : visibility !== "local" ? "Continue in the original thread" : "Setup ended"}`}
      />
    );
  const integration = summary?.integration;
  const start = () => {
    setPending(true);
    setError(null);
    void openSignInPage(async () => {
      if (!integration) return null;
      const result = await signIn({ environmentId, input: { id: integration.id } });
      if (result._tag === "Success") return result.value.authorizationUrl;
      if (!isAtomCommandInterrupted(result))
        setError(integrationErrorText(squashAtomCommandFailure(result)));
      return null;
    })
      .catch(() => setError("Could not open the sign-in page. Try again."))
      .finally(() => setPending(false));
  };
  const save = async () => {
    if (pending) return;
    if (catalogId && (setup?.type === "api_key" || setup?.type === "oauth_client")) {
      setPending(true);
      setError(null);
      const targetInput = {
        catalogId,
        ...(integration ? { integrationId: integration.id } : {}),
        ...(target?.accountLabel ? { accountLabel: target.accountLabel } : {}),
      };
      const result =
        setup.type === "api_key"
          ? await saveKey({ environmentId, input: { ...targetInput, apiKey: credential } })
          : await saveClient({
              environmentId,
              input: { ...targetInput, clientId: clientId ?? "", clientSecret: credential },
            });
      setPending(false);
      if (result._tag === "Success") {
        setCredential("");
        edit(false);
      } else if (!isAtomCommandInterrupted(result))
        setError(integrationErrorText(squashAtomCommandFailure(result)));
      return;
    }
    if (!integration) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        id: integration.id,
        enabled: true,
        ...(url === null ? {} : { url }),
        ...(integration.auth?.type === "oauth"
          ? {
              auth: {
                ...integration.auth,
                ...(clientId === null ? {} : { clientId }),
                ...(scope === null ? {} : { scope }),
              },
            }
          : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") edit(false);
    else if (!isAtomCommandInterrupted(result))
      setError(integrationErrorText(squashAtomCommandFailure(result)));
  };
  return (
    <ThreadPromptCard data-v2-item-type={item.type}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center" aria-hidden>
          <IntegrationSourceIcon
            icon={(integration ? integrationCatalogEntryFor(integration)?.icon : catalogId) ?? null}
            className="size-4"
          />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{item.label}</p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {summary?.message ?? setup?.message ?? item.reason}
          </p>
        </div>
      </div>
      {setup?.type === "api_key" || setup?.type === "oauth_client" ? (
        <div className="flex flex-col gap-2">
          {setup.type === "oauth_client" ? (
            <>
              {setup.steps.map((step) => (
                <p key={step.text} className="text-xs text-muted-foreground">
                  {step.text}
                  {step.url ? (
                    <Button
                      size="xs"
                      variant="link"
                      onClick={() => void openSignInPage(() => Promise.resolve(step.url ?? null))}
                    >
                      Open
                    </Button>
                  ) : null}
                  {step.copy ? <code>{step.copy.value}</code> : null}
                </p>
              ))}
              <label className="text-xs text-muted-foreground">
                Client ID
                <Input
                  value={clientId ?? ""}
                  onChange={(event) => setClientId(event.currentTarget.value)}
                />
              </label>
            </>
          ) : null}
          <label className="text-xs text-muted-foreground">
            {setup.type === "api_key" ? setup.label : "Client secret"}
            <Input
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(event) => setCredential(event.currentTarget.value)}
            />
          </label>
          <div>
            <Button
              size="sm"
              disabled={pending || !canUpdate || !credential.trim()}
              onClick={() => void save()}
            >
              Save securely
            </Button>
          </div>
        </div>
      ) : setup?.type === "install_runtime" ? (
        <div>
          <Button
            size="sm"
            disabled={pending || !setup.canInstall || !canUpdate}
            onClick={() => {
              setPending(true);
              void install({ environmentId, input: { runtime: setup.runtime } })
                .then((result) => {
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
                    setError(integrationErrorText(squashAtomCommandFailure(result)));
                })
                .finally(() => setPending(false));
            }}
          >
            Install runtime
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={pending || !integration || !canSignIn} onClick={start}>
              {pending ? "Opening sign-in…" : "Sign in"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !canUpdate}
              onClick={() => edit(!editing)}
            >
              Fix
            </Button>
          </div>
          <WorkLogCollapse open={editing}>
            {integration ? (
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">
                  Server URL
                  <Input
                    value={url ?? integration.url}
                    onChange={(event) => setUrl(event.currentTarget.value)}
                  />
                </label>
                {integration.auth?.type === "oauth" ? (
                  <>
                    <label className="text-xs text-muted-foreground">
                      Client ID (if required)
                      <Input
                        value={clientId ?? integration.auth.clientId ?? ""}
                        onChange={(event) => setClientId(event.currentTarget.value)}
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      OAuth scopes
                      <Input
                        value={scope ?? integration.auth.scope ?? ""}
                        onChange={(event) => setScope(event.currentTarget.value)}
                      />
                    </label>
                  </>
                ) : null}
                <div>
                  <Button size="sm" disabled={pending || !canUpdate} onClick={() => void save()}>
                    Save change
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setUrl(null);
                      setClientId(null);
                      setScope(null);
                      edit(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </WorkLogCollapse>
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </ThreadPromptCard>
  );
}

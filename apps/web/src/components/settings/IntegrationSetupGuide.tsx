import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IntegrationCatalogId,
  IntegrationConnectResult,
  IntegrationId,
  IntegrationSetupStep,
} from "@t3tools/contracts";
import { ExternalLinkIcon, PlugZapIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { ensureLocalApi } from "../../localApi";
import { integrationsRpc } from "../../rpc/integrations";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { CopyableValue } from "./CopyableValue";
import { catalogErrorText, type GuidedSetup } from "./integrationCatalog.logic";
import { urlHost } from "./integrationServices.logic";
import { SecretInput } from "./SecretInput";

/** Opens a link: the system browser on desktop, a new tab on the web. */
export function openInBrowser(url: string) {
  if (window.desktopBridge) void ensureLocalApi().shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens the service's sign-in page from a click. A web browser blocks a tab
 * opened after an await, so the tab opens first and follows the link once the
 * server returns it; the desktop app hands the link to the system browser.
 */
export async function openSignInPage(link: () => Promise<string | null>) {
  const tab = window.desktopBridge ? null : window.open("", "_blank");
  const url = await link();
  if (url === null) {
    tab?.close();
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
    return;
  }
  await ensureLocalApi().shell.openExternal(url);
}

/** Who a saved client or key is for: an existing account, or a new one of the service. */
export interface SetupTarget {
  readonly catalogId: IntegrationCatalogId;
  readonly integrationId?: IntegrationId | undefined;
  /** A new account's name; empty for none. */
  readonly accountLabel?: string | undefined;
}

/**
 * One guided setup step, inline: the service's numbered steps with their
 * links and values to copy, then the private form for the client ID and
 * secret or the key. Secrets go straight to the server, which keeps them in
 * the vault; this form forgets them once saved. A missing program the
 * connection can't install shows the command to run instead.
 *
 * An account row renders it under the row (its message is already the row's
 * description); adding a service renders it under the Add row with the message.
 */
export function IntegrationSetupGuide(props: {
  readonly environmentId: EnvironmentId;
  readonly action: GuidedSetup;
  /** Absent only for `install_runtime`, which saves nothing. */
  readonly target: SetupTarget | undefined;
  readonly showMessage?: boolean;
  readonly disabled: boolean;
  /** Checked before saving, e.g. that a new account has its name. */
  readonly validate?: () => string | null;
  /** The save's result; returns the sign-in link to open, if any. Defaults to the result's own link. */
  readonly onSaved?: (result: IntegrationConnectResult) => string | null;
  /** Re-checks the account, once a command was run by hand. */
  readonly onTest?: () => void;
}) {
  const { action } = props;
  return (
    <section aria-label={action.title} className="space-y-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-medium text-foreground">{action.title}</h4>
        {props.showMessage ? (
          <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {action.message}
          </p>
        ) : null}
      </div>
      {action.type === "install_runtime" ? (
        <div className="space-y-2">
          <CopyableValue value={action.command} label="Command" />
          {props.onTest ? (
            <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onTest}>
              <PlugZapIcon />
              Test again
            </Button>
          ) : null}
        </div>
      ) : props.target === undefined ? null : action.type === "oauth_client" ? (
        <>
          <SetupSteps steps={action.steps} />
          <OAuthClientForm
            environmentId={props.environmentId}
            target={props.target}
            disabled={props.disabled}
            validate={props.validate}
            onSaved={props.onSaved}
          />
        </>
      ) : (
        <ApiKeyForm
          environmentId={props.environmentId}
          target={props.target}
          label={action.label}
          url={action.url}
          disabled={props.disabled}
          validate={props.validate}
          onSaved={props.onSaved}
        />
      )}
    </section>
  );
}

/** The service's own console steps, numbered, each with its page and what to paste there. */
function SetupSteps(props: { readonly steps: ReadonlyArray<IntegrationSetupStep> }) {
  return (
    <ol className="space-y-3">
      {props.steps.map((step, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- steps are fixed text in a fixed order
        <li key={index} className="flex gap-2.5">
          <span
            aria-hidden="true"
            className="mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium tabular-nums text-muted-foreground"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs leading-normal text-foreground">{step.text}</p>
            {step.url === undefined ? null : (
              <Button
                size="xs"
                variant="outline"
                aria-label={`Open ${urlHost(step.url)}`}
                title={step.url}
                onClick={() => openInBrowser(step.url!)}
              >
                <ExternalLinkIcon />
                Open {urlHost(step.url)}
              </Button>
            )}
            {step.copy === undefined ? null : (
              <CopyableValue value={step.copy.value} label={step.copy.label} />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

interface SecretFormProps {
  readonly environmentId: EnvironmentId;
  readonly target: SetupTarget;
  readonly disabled: boolean;
  readonly validate?: (() => string | null) | undefined;
  readonly onSaved?: ((result: IntegrationConnectResult) => string | null) | undefined;
}

const targetFields = (target: SetupTarget) => {
  const accountLabel = target.accountLabel?.trim() ?? "";
  return {
    catalogId: target.catalogId,
    ...(target.integrationId === undefined ? {} : { integrationId: target.integrationId }),
    ...(accountLabel === "" ? {} : { accountLabel }),
  };
};

/** Client ID in the open, client secret masked; saving signs in next. */
function OAuthClientForm(props: SecretFormProps) {
  const save = useOrchestrationCommand(integrationsRpc.saveOAuthClient, { reportFailure: false });
  const id = useId();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const problem =
      clientId.trim() === ""
        ? "Paste the app's client ID."
        : clientSecret.trim() === ""
          ? "Paste the app's client secret."
          : (props.validate?.() ?? null);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await openSignInPage(async () => {
        const result = await save({
          environmentId: props.environmentId,
          input: {
            ...targetFields(props.target),
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim(),
          },
        });
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result))
            setError(catalogErrorText(squashAtomCommandFailure(result)));
          return null;
        }
        setClientId("");
        setClientSecret("");
        if (props.onSaved) return props.onSaved(result.value);
        if (result.value.signIn === undefined && result.value.setup !== undefined)
          setError(result.value.setup.message);
        return result.value.signIn?.authorizationUrl ?? null;
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <SecretForm pending={pending} error={error} submitLabel="Save and sign in" onSubmit={submit}>
      <fieldset
        disabled={pending || props.disabled}
        className="grid gap-2 @min-[32rem]/settings-row:grid-cols-2"
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-client-id`}>Client ID</Label>
          <Input
            id={`${id}-client-id`}
            value={clientId}
            maxLength={500}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setClientId(event.currentTarget.value);
              setError(null);
            }}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-client-secret`}>Client secret</Label>
          <SecretInput
            id={`${id}-client-secret`}
            revealable
            value={clientSecret}
            maxLength={8192}
            placeholder="Paste the client secret"
            onChange={(event) => {
              setClientSecret(event.currentTarget.value);
              setError(null);
            }}
          />
        </div>
      </fieldset>
    </SecretForm>
  );
}

/** Where to create the key, then the key, masked. */
function ApiKeyForm(
  props: SecretFormProps & { readonly label: string; readonly url: string | undefined },
) {
  const save = useOrchestrationCommand(integrationsRpc.saveApiKey, { reportFailure: false });
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const problem =
      apiKey.trim() === ""
        ? `Paste the ${props.label.toLowerCase()}.`
        : (props.validate?.() ?? null);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await save({
        environmentId: props.environmentId,
        input: { ...targetFields(props.target), apiKey: apiKey.trim() },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result))
          setError(catalogErrorText(squashAtomCommandFailure(result)));
        return;
      }
      setApiKey("");
      // A key never signs in, so there is no page to open.
      props.onSaved?.(result.value);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      {props.url === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Create one on ${urlHost(props.url)}`}
          title={props.url}
          onClick={() => openInBrowser(props.url!)}
        >
          <ExternalLinkIcon />
          Create one on {urlHost(props.url)}
        </Button>
      )}
      <SecretForm pending={pending} error={error} submitLabel="Save" onSubmit={submit}>
        <fieldset disabled={pending || props.disabled} className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-api-key`}>{props.label}</Label>
          <SecretInput
            id={`${id}-api-key`}
            revealable
            value={apiKey}
            maxLength={8192}
            placeholder={`Paste the ${props.label.toLowerCase()}`}
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setError(null);
            }}
          />
        </fieldset>
      </SecretForm>
    </div>
  );
}

/** A secret form's frame: its fields, the save button, where the secret goes, and any failure. */
function SecretForm(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly submitLabel: string;
  readonly onSubmit: () => Promise<void>;
  readonly children: ReactNode;
}) {
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSubmit();
      }}
    >
      {props.children}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" size="xs" disabled={props.pending}>
          {props.pending ? <Spinner /> : null}
          {props.pending ? "Saving…" : props.submitLabel}
        </Button>
        <span className="text-xs text-muted-foreground">
          Kept in your vault. Agents and chats never see it.
        </span>
      </div>
      <AnimatedHeight>
        {props.error ? (
          <p role="alert" className="text-xs text-destructive">
            {props.error}
          </p>
        ) : null}
      </AnimatedHeight>
    </form>
  );
}

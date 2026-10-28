import { useAtomValue } from "@effect/atom-react";
import {
  isProviderSignInActive,
  PROVIDER_SIGN_IN_LOCAL_INITIAL,
  providerSignInForMachine,
  providerSignInStep,
  shouldAutoStartProviderSignIn,
  type ProviderSignInLocal,
  type ProviderSignInStep,
  type ProviderSignInTarget,
} from "@cogenly/client-runtime/provider-sign-in";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthRespondInput,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProviderAuthStatus,
} from "@cogenly/contracts";
import { CheckIcon, CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useEnvironmentMachineList } from "../../machines/useMachines";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AnimatedHeight } from "../AnimatedHeight";
import { openSignInPage } from "../settings/openIntegrationSignIn";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

const ProviderAuthTerminal = lazy(() => import("../settings/ProviderAuthTerminal"));

/** What opens a sign-in. Names are looked up from the machine list when omitted. */
export interface ProviderSignInRequest {
  readonly environmentId: EnvironmentId;
  readonly targetEnvironmentId?: EnvironmentId | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly providerName?: string | undefined;
  readonly machineName?: string | undefined;
  /** Sign in again on a machine that is already signed in, to switch accounts. */
  readonly changeAccount?: boolean | undefined;
}

export interface ResolvedProviderSignIn extends ProviderSignInTarget {
  readonly providerAuth: ServerProviderAuthStatus | undefined;
  readonly canSignIn: boolean;
  readonly documentationUrl: string | undefined;
}

/** The target's names and live sign-in status, from its machine list and provider list. */
export function useResolvedProviderSignIn(request: ProviderSignInRequest): ResolvedProviderSignIn {
  const list = useEnvironmentMachineList(request.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(request.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const machine = providerSignInForMachine({
    viaEnvironmentId: request.environmentId,
    list,
    instanceId: request.instanceId,
    machineEnvironmentId: request.targetEnvironmentId ?? null,
  });
  // The connected server always knows its own providers, even before machines are listed.
  const local =
    request.targetEnvironmentId === undefined
      ? providers.find((provider) => provider.instanceId === request.instanceId)
      : undefined;
  return {
    environmentId: request.environmentId,
    ...(request.targetEnvironmentId ? { targetEnvironmentId: request.targetEnvironmentId } : {}),
    instanceId: request.instanceId,
    providerName:
      request.providerName ??
      machine?.providerName ??
      local?.displayName?.trim() ??
      request.instanceId,
    machineName:
      request.machineName ??
      machine?.machineName ??
      list?.machines.find((candidate) => candidate.relation === "this")?.name ??
      "this machine",
    // Switching accounts starts a flow even though the machine is signed in.
    providerAuth: request.changeAccount ? undefined : (machine?.auth ?? local?.auth.status),
    canSignIn: machine?.canSignIn ?? local?.setup?.canAuthenticate !== false,
    documentationUrl: local?.setup?.documentationUrl,
  };
}

const failureText = (
  result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim() ? failure.message : fallback;
};

/**
 * Runs one sign-in against the machine that signs in. Every value it returns
 * is the machine's flow state or a command this client has in flight.
 */
export function useProviderSignInFlow(
  target: ResolvedProviderSignIn,
  options: { readonly autoStart: boolean; readonly onSucceeded?: (() => void) | undefined },
) {
  const input = {
    instanceId: target.instanceId,
    ...(target.targetEnvironmentId ? { targetEnvironmentId: target.targetEnvironmentId } : {}),
  };
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId: target.environmentId, input }),
  );
  const commandOptions = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commandOptions);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, commandOptions);
  const canManage = useAtomValue(
    serverEnvironment.startProviderAuth.permissionAtom(target.environmentId),
  );
  const [local, setLocal] = useState<ProviderSignInLocal>(PROVIDER_SIGN_IN_LOCAL_INITIAL);
  // Enter then a click can both run before a re-render; these guards are synchronous.
  const inFlight = useRef(false);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const auth = query.data ?? undefined;
  const step = providerSignInStep({
    auth,
    providerAuth: target.providerAuth,
    canSignIn: target.canSignIn,
    local: query.error && !local.error ? { ...local, error: query.error } : local,
  });
  const update = (patch: Partial<ProviderSignInLocal>) =>
    setLocal((current) => ({ ...current, ...patch }));

  const begin = async (methodId?: string) => {
    if (inFlight.current || !canManage) return;
    inFlight.current = true;
    setLocal({ ...PROVIDER_SIGN_IN_LOCAL_INITIAL, starting: true });
    const result = await start({
      environmentId: target.environmentId,
      input: { ...input, ...(methodId ? { methodId } : {}) },
    });
    inFlight.current = false;
    if (result._tag === "Success") update({ starting: false, startedFlowId: result.value.flowId });
    else if (isAtomCommandInterrupted(result)) update({ starting: false });
    else
      update({
        starting: false,
        error: failureText(result, `Could not start signing in on ${target.machineName}.`),
      });
  };

  const send = async (interactionId: string, response: ProviderAuthResponse) => {
    if (inFlight.current || !auth?.flowId) return false;
    inFlight.current = true;
    update({ responding: true, error: null });
    const result = await respond({
      environmentId: target.environmentId,
      input: { ...input, flowId: auth.flowId, interactionId, response },
    });
    inFlight.current = false;
    if (result._tag === "Success") {
      update({
        responding: false,
        ...(response.type === "credentials"
          ? { answeredInteraction: `${auth.flowId}:${interactionId}` }
          : {}),
      });
      return true;
    }
    update({
      responding: false,
      ...(isAtomCommandInterrupted(result)
        ? {}
        : { error: failureText(result, "The sign-in did not accept that. Try again.") }),
    });
    return false;
  };

  const openPage = (url: string, consentInteractionId?: string) =>
    openSignInPage(async () => {
      // Consent is recorded on the machine before its provider URL opens.
      if (
        consentInteractionId &&
        !(await send(consentInteractionId, { type: "browser", action: "accept" }))
      )
        return null;
      return url;
    }).catch(() =>
      update({ error: "Could not open the sign-in page. Copy the link and open it yourself." }),
    );

  const submitCallback = async (callbackUrl: string) => {
    if (inFlight.current || !auth?.flowId) return;
    inFlight.current = true;
    update({ responding: true, error: null });
    const result = await complete({
      environmentId: target.environmentId,
      input: { ...input, flowId: auth.flowId, callbackUrl },
    });
    inFlight.current = false;
    update({
      responding: false,
      ...(result._tag === "Success" || isAtomCommandInterrupted(result)
        ? {}
        : { error: failureText(result, "That address did not finish the sign-in.") }),
    });
  };

  const sendTerminal = (
    interactionId: string,
    response: Extract<ProviderAuthResponse, { type: "terminal" }>,
  ) => {
    if (!auth?.flowId) return;
    for (let offset = 0; offset < Math.max(1, response.data.length); offset += 4_096)
      terminalQueue.current.push({
        ...input,
        flowId: auth.flowId,
        interactionId,
        response: { ...response, data: response.data.slice(offset, offset + 4_096) },
      });
    if (terminalSending.current) return;
    terminalSending.current = true;
    void (async () => {
      while (terminalQueue.current.length > 0) {
        const next = terminalQueue.current.shift()!;
        const result = await respond({ environmentId: target.environmentId, input: next });
        if (result._tag !== "Success") {
          terminalQueue.current = [];
          if (!isAtomCommandInterrupted(result))
            update({ error: "The sign-in terminal is no longer available." });
          break;
        }
      }
    })().finally(() => {
      terminalSending.current = false;
    });
  };

  const canCancel =
    canManage &&
    isProviderSignInActive(step) &&
    ((step.kind === "elsewhere" && auth?.flowEpoch != null) ||
      (auth?.flowId != null && auth.flowId === local.startedFlowId));

  /** Cancels the machine's flow; resolves once it has stopped (or there was none to stop). */
  const stop = async () => {
    const flowId = auth?.flowId;
    if (!canCancel) return;
    update({ cancelling: true });
    const result = await cancel({
      environmentId: target.environmentId,
      input: {
        ...input,
        flowId: flowId ?? null,
        ...(auth?.flowEpoch ? { flowEpoch: auth.flowEpoch } : {}),
      },
    });
    update({
      cancelling: false,
      ...(result._tag === "Success" ? { startedFlowId: result.value.flowId } : {}),
      ...(result._tag === "Success" || isAtomCommandInterrupted(result)
        ? {}
        : { error: failureText(result, "Could not cancel the sign-in.") }),
    });
  };

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!options.autoStart || autoStarted.current || !canManage) return;
    if (!shouldAutoStartProviderSignIn(step)) return;
    autoStarted.current = true;
    void begin();
  });

  const finished = useRef(false);
  const onSucceeded = options.onSucceeded;
  useEffect(() => {
    if (step.kind !== "succeeded" || finished.current) return;
    finished.current = true;
    // A remote machine refreshes its own status when its CLI finishes.
    if (!target.targetEnvironmentId)
      void refreshProviders({
        environmentId: target.environmentId,
        input: { instanceId: target.instanceId },
      });
    onSucceeded?.();
  }, [
    onSucceeded,
    refreshProviders,
    step.kind,
    target.environmentId,
    target.instanceId,
    target.targetEnvironmentId,
  ]);

  return {
    step,
    local,
    canManage,
    canCancel,
    begin,
    send,
    openPage,
    submitCallback,
    sendTerminal,
    stop,
  };
}

export type ProviderSignInFlowState = ReturnType<typeof useProviderSignInFlow>;

function Status({
  children,
  busy = false,
}: {
  readonly children: ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      {busy ? <Spinner size="sm" tone="muted" /> : null}
      {children}
    </p>
  );
}

function OpenPageButton(props: {
  readonly url: string;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" disabled={props.disabled} onClick={props.onOpen}>
        <ExternalLinkIcon aria-hidden />
        Open sign-in page
      </Button>
      <CopyButton
        value={props.url}
        label="Copy sign-in link"
        target="sign-in link"
        size="icon-sm"
        variant="ghost-muted"
        disabled={props.disabled}
      />
    </div>
  );
}

/** Claude's step: open the page, then paste the code. A pasted code submits at once. */
function CodeStep({
  flow,
  step,
}: {
  readonly flow: ProviderSignInFlowState;
  readonly step: Extract<ProviderSignInStep, { kind: "code" }>;
}) {
  const inputId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const disabled = step.submitting || !flow.canManage;
  const submit = (next: Record<string, string>) => {
    if (step.interaction.fields.some((field) => !next[field.name]?.trim())) return;
    void flow.send(step.interaction.id, { type: "credentials", values: next }).then((sent) => {
      // The code is never kept once the machine has it.
      if (sent) setValues({});
    });
  };
  const single = step.interaction.fields.length === 1 ? step.interaction.fields[0] : undefined;
  return (
    <ol className="flex flex-col gap-4 text-sm">
      {step.url ? (
        <li className="flex flex-col gap-2">
          <span className="text-foreground">1. Open the sign-in page and approve access.</span>
          <OpenPageButton
            url={step.url}
            disabled={!flow.canManage}
            onOpen={() => void flow.openPage(step.url!)}
          />
        </li>
      ) : null}
      <li>
        <form
          className="flex flex-col gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            submit(values);
          }}
        >
          <label htmlFor={inputId} className="text-foreground">
            {step.url ? "2. " : ""}
            {single ? "Paste the code the page shows." : "Enter your sign-in details."}
          </label>
          {step.interaction.fields.map((field, index) => (
            <Input
              key={field.name}
              id={index === 0 ? inputId : undefined}
              aria-label={field.label}
              placeholder={field.label}
              // Masked text rather than a password field: browsers offer to save passwords.
              type="text"
              className={field.secret ? "[-webkit-text-security:disc]" : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              value={values[field.name] ?? ""}
              disabled={disabled}
              maxLength={16_384}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.currentTarget.value }))
              }
              onPaste={(event) => {
                if (!single) return;
                const pasted = event.clipboardData.getData("text").trim();
                if (!pasted || /[\r\n]/.test(pasted)) return;
                event.preventDefault();
                const next = { [single.name]: pasted };
                setValues(next);
                submit(next);
              }}
            />
          ))}
          <div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={
                disabled || step.interaction.fields.some((field) => !values[field.name]?.trim())
              }
              busy={step.submitting}
            >
              {step.submitting ? <Spinner size="sm" /> : null}
              {step.submitting ? "Sending code" : "Continue"}
            </Button>
          </div>
        </form>
      </li>
    </ol>
  );
}

function CallbackForm({ flow }: { readonly flow: ProviderSignInFlowState }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-col gap-2 text-sm"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) void flow.submitCallback(value.trim()).then(() => setValue(""));
      }}
    >
      <label className="flex flex-col gap-1 text-muted-foreground">
        If the last page doesn't load, paste its address here.
        <Input
          type="url"
          size="sm"
          autoComplete="off"
          value={value}
          disabled={flow.local.responding || !flow.canManage}
          maxLength={16_384}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!flow.canManage || !value.trim()}
          busy={flow.local.responding}
        >
          Continue
        </Button>
      </div>
    </form>
  );
}

function MethodStep({
  flow,
  step,
  machineName,
}: {
  readonly flow: ProviderSignInFlowState;
  readonly step: Extract<ProviderSignInStep, { kind: "choose-method" }>;
  readonly machineName: string;
}) {
  const [methodId, setMethodId] = useState(step.methods[0]?.id ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={methodId} onValueChange={(value) => setMethodId(value ?? "")}>
        <SelectTrigger size="sm" aria-label="Sign-in method" className="w-56">
          <SelectValue>{step.methods.find((method) => method.id === methodId)?.name}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {step.methods.map((method) => (
            <SelectItem key={method.id} value={method.id}>
              {method.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        disabled={!flow.canManage || !methodId}
        onClick={() => void flow.begin(methodId)}
      >
        Sign in on {machineName}
      </Button>
    </div>
  );
}

function StepBody({
  flow,
  target,
}: {
  readonly flow: ProviderSignInFlowState;
  readonly target: ResolvedProviderSignIn;
}) {
  const { step } = flow;
  switch (step.kind) {
    case "loading":
      return <Status busy>Checking {target.machineName}…</Status>;
    case "unsupported":
      return (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            {target.providerName} signs in on {target.machineName} itself, outside Cogenly.
          </p>
          {target.documentationUrl ? (
            <div>
              <Button
                size="sm"
                variant="outline"
                render={<a href={target.documentationUrl} target="_blank" rel="noreferrer" />}
              >
                Open setup guide
              </Button>
            </div>
          ) : null}
        </div>
      );
    case "ready":
      return (
        <div>
          <Button size="sm" disabled={!flow.canManage} onClick={() => void flow.begin()}>
            Sign in on {target.machineName}
          </Button>
        </div>
      );
    case "choose-method":
      return <MethodStep flow={flow} step={step} machineName={target.machineName} />;
    case "starting":
      return <Status busy>Starting sign-in on {target.machineName}…</Status>;
    case "elsewhere":
      return (
        <Status>
          A sign-in is already open on {target.machineName} in another window. You can cancel it
          here to start again.
        </Status>
      );
    case "code":
      return <CodeStep flow={flow} step={step} />;
    case "device-code":
      return (
        <div className="flex flex-col gap-3 text-sm">
          <span className="text-foreground">Enter this code on the sign-in page.</span>
          <div className="flex items-center gap-2">
            <code className="select-all font-mono text-2xl font-semibold tracking-widest text-foreground">
              {step.userCode}
            </code>
            <CopyButton
              value={step.userCode}
              label="Copy code"
              target="sign-in code"
              size="icon-sm"
            />
          </div>
          <OpenPageButton
            url={step.url}
            disabled={!flow.canManage}
            onOpen={() => void flow.openPage(step.url)}
          />
          <Status busy>Waiting for you to approve it in the browser.</Status>
        </div>
      );
    case "browser":
      return (
        <div className="flex flex-col gap-3 text-sm">
          <span className="text-foreground">Open the sign-in page and approve access.</span>
          <OpenPageButton
            url={step.url}
            disabled={!flow.canManage || flow.local.responding}
            onOpen={() =>
              void flow.openPage(
                step.url,
                step.interaction?.requiresConsent ? step.interaction.id : undefined,
              )
            }
          />
          {step.interaction?.acceptsCallback ? <CallbackForm flow={flow} /> : null}
          <Status busy>Waiting for you to finish in the browser.</Status>
        </div>
      );
    case "terminal":
      return (
        <Suspense fallback={<Status busy>Loading the sign-in terminal…</Status>}>
          <ProviderAuthTerminal
            key={step.interaction.id}
            output={step.interaction.output}
            outputOffset={step.interaction.outputOffset}
            onResponse={(response) => {
              if (flow.canManage) flow.sendTerminal(step.interaction.id, response);
            }}
          />
        </Suspense>
      );
    case "verifying":
      return <Status busy>Checking your sign-in…</Status>;
    case "succeeded":
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-foreground">
          <CheckIcon className="size-4 text-success" aria-hidden />
          Signed in on {target.machineName}.
        </p>
      );
    case "failed":
      return (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="[overflow-wrap:anywhere]">{step.message}</span>
        </p>
      );
    case "cancelled":
      return <Status>Sign-in cancelled.</Status>;
  }
}

/**
 * The guided sign-in body, shared by the dialog, the inline thread card and
 * the provider wizard. Its container supplies the title; `footer` lays out
 * the Cancel and Try again actions it returns.
 */
export function ProviderSignInFlow({
  target,
  flow,
  children,
}: {
  readonly target: ResolvedProviderSignIn;
  readonly flow: ProviderSignInFlowState;
  /** Extra actions beside Cancel / Try again, such as Close. */
  readonly children?: ReactNode;
}) {
  const { step } = flow;
  const retry = step.kind === "failed" || step.kind === "cancelled";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AnimatedHeight>
        {/* Keyed by step so each one fades in where the last one was. */}
        <div key={step.kind} className="swap-motion">
          <StepBody flow={flow} target={target} />
        </div>
      </AnimatedHeight>
      {!flow.canManage && step.kind !== "succeeded" && step.kind !== "unsupported" ? (
        <p className="text-xs text-muted-foreground">
          This device can't change sign-ins on {target.machineName}.
        </p>
      ) : null}
      {flow.canCancel || retry || children ? (
        <div className="flex flex-wrap items-center gap-2">
          {retry ? (
            <Button size="sm" disabled={!flow.canManage} onClick={() => void flow.begin()}>
              {step.kind === "cancelled" ? "Sign in again" : "Try again"}
            </Button>
          ) : null}
          {flow.canCancel ? (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={flow.local.cancelling}
              onClick={() => void flow.stop()}
            >
              {flow.local.cancelling ? "Cancelling" : "Cancel"}
            </Button>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

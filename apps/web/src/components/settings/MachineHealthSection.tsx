import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type IntegrationCatalogId,
  type MachineHealthChannelTestResult,
  type MachineHealthCheck,
  type MachineHealthItem,
  type MachineHealthReport,
  type MachineHealthStatus,
  type MachineInfo,
  type MachineListResult,
} from "@cogenly/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  healthItemActions,
  machineHealthAnchorId,
  type MachineHealthAction,
  type MachineHealthActionContext,
} from "../../machines/machineHealthLinks.logic";
import {
  machineHealthActionPermissionAtom,
  useRunMachineHealthAction,
} from "../../machines/useRunMachineHealthAction";
import { integrationsRpc } from "../../rpc/integrations";
import { machinesRpc } from "../../rpc/machines";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { createIntegrationStatusFade } from "./integrationStatusMotion";
import {
  isConnectingReport,
  alertChannelIntegrations,
  canaryIntervalOptions,
  canaryMachineId,
  channelTestLines,
  HEALTH_CHECK_LABELS,
  HEALTH_STATUS_BADGE_VARIANTS,
  HEALTH_STATUS_LABELS,
  healthHeadline,
  partitionHealthChecks,
  unreachableHeadline,
  uptimeLabel,
} from "./MachineHealthSection.logic";
import {
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Fades an element when `status` changes, never on mount. */
function useStatusFade<T extends HTMLElement>(status: string) {
  const node = useRef<T>(null);
  const fade = useRef<ReturnType<typeof createIntegrationStatusFade> | null>(null);
  useLayoutEffect(() => {
    if (!node.current) return;
    const created = createIntegrationStatusFade(node.current);
    fade.current = created;
    return () => created.dispose();
  }, []);
  useLayoutEffect(() => {
    fade.current?.update(status);
  }, [status]);
  return node;
}

/** Keys that showed up after the first value, so only live arrivals fade in. */
function useArrivedKeys(keys: ReadonlyArray<string> | null): (key: string) => boolean {
  const [initial, setInitial] = useState<ReadonlySet<string> | null>(null);
  if (keys !== null && initial === null) setInitial(new Set(keys));
  return (key) => initial !== null && !initial.has(key);
}

/** An arriving row's fade: opacity only, also under reduced motion. */
const ARRIVAL_FADE =
  "transition-opacity duration-(--motion-duration-base) ease-out starting:opacity-0";

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function isoLabel(value: DateTime.Utc): string {
  return formatRelativeTimeLabel(DateTime.formatIso(value));
}

/**
 * Settings → Machines: one health section per machine the viewed server
 * knows, each read through that server (the others over the peer link).
 * The canary lives on the hub's section, external alert channels on the
 * viewed machine's own.
 */
export function MachineHealthSections({
  environment,
}: {
  readonly environment: EnvironmentPresentation | null;
}) {
  const environmentId = environment?.environmentId ?? null;
  const list = useEnvironmentQuery(
    environmentId === null ? null : machinesRpc.list({ environmentId, input: {} }),
  ).data;
  const connectedIds = useConnectedEnvironmentIds();
  if (environment === null || list === null) return null;
  const canaryId = canaryMachineId(list);
  const connected = new Set(connectedIds);
  return (
    <SettingsSearchTarget
      id={searchableSetting("machine-health").id}
      className="flex flex-col gap-8"
    >
      {list.machines
        .toSorted(
          (left, right) => Number(right.relation === "this") - Number(left.relation === "this"),
        )
        .map((machine) => (
          <MachineHealthSection
            key={machine.environmentId}
            viewed={environment}
            machine={machine}
            list={list}
            runsCanary={machine.environmentId === canaryId}
            isConnected={(id) => connected.has(id)}
          />
        ))}
    </SettingsSearchTarget>
  );
}

function StatusBadge({ status }: { readonly status: MachineHealthStatus | "connecting" }) {
  const node = useStatusFade<HTMLSpanElement>(status);
  return (
    <span ref={node} className="flex">
      {status === "connecting" ? (
        <Badge size="sm" variant="outline">
          Connecting…
        </Badge>
      ) : (
        <Badge size="sm" variant={HEALTH_STATUS_BADGE_VARIANTS[status]}>
          {HEALTH_STATUS_LABELS[status]}
        </Badge>
      )}
    </span>
  );
}

function MachineHealthSection({
  viewed,
  machine,
  list,
  runsCanary,
  isConnected,
}: {
  readonly viewed: EnvironmentPresentation;
  readonly machine: MachineInfo;
  readonly list: MachineListResult;
  readonly runsCanary: boolean;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
}) {
  const isThis = machine.relation === "this";
  const query = useEnvironmentQuery(
    machinesRpc.health({
      environmentId: viewed.environmentId,
      input: isThis ? {} : { environmentId: machine.environmentId },
    }),
  );
  const report = query.data;
  const connecting = report !== null && isConnectingReport(report, machine.online);
  const overall: MachineHealthStatus | "connecting" | null =
    report === null ? null : connecting ? "connecting" : report.reachable ? report.status : "fail";
  const context: MachineHealthActionContext = {
    originEnvironmentId: machine.environmentId,
    viaEnvironmentId: viewed.environmentId,
    isConnected,
  };

  return (
    <SettingsSection
      id={machineHealthAnchorId(machine.environmentId)}
      title={`${machine.name} health`}
      headerAction={overall === null ? null : <StatusBadge status={overall} />}
    >
      {report === null ? (
        query.error !== null ? (
          <SettingsRow
            title={`Couldn't check ${machine.name}'s health`}
            description={query.error}
          />
        ) : (
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <Spinner size="sm" tone="muted" />
                Checking {machine.name}…
              </span>
            }
            role="status"
          />
        )
      ) : connecting ? (
        <SettingsRow
          title={`Connecting to ${machine.name}…`}
          description="It hasn't checked in yet. This usually takes a few seconds."
          role="status"
        />
      ) : (
        <HealthReportRows report={report} machine={machine} viewed={viewed} context={context} />
      )}
      {runsCanary ? <CanaryRow machine={machine} list={list} /> : null}
      {isThis ? <AlertChannelRows environment={viewed} /> : null}
    </SettingsSection>
  );
}

/** The summary row, the checks that need attention, then the rest behind a disclosure. */
function HealthReportRows({
  report,
  machine,
  viewed,
  context,
}: {
  readonly report: MachineHealthReport;
  readonly machine: MachineInfo;
  readonly viewed: EnvironmentPresentation;
  readonly context: MachineHealthActionContext;
}) {
  const { problems, others } = partitionHealthChecks(report.checks);
  const arrived = useArrivedKeys(problems.map((check) => check.id));
  return (
    <>
      <HealthSummaryRow report={report} machine={machine} viewed={viewed} />
      {problems.map((check) => (
        <SettingsRow
          key={check.id}
          className={arrived(check.id) ? ARRIVAL_FADE : undefined}
          title={HEALTH_CHECK_LABELS[check.id]}
          description={check.summary}
          control={<StatusBadge status={check.status} />}
        >
          <AnimatedHeight>
            {check.items.length > 0 ? (
              <ul className="space-y-3 pt-1 pb-2">
                {check.items.map((item) => (
                  <HealthItemRow key={item.key} item={item} context={context} />
                ))}
              </ul>
            ) : null}
          </AnimatedHeight>
        </SettingsRow>
      ))}
      {others.length > 0 ? <OtherChecksRow checks={others} context={context} /> : null}
    </>
  );
}

function HealthSummaryRow({
  report,
  machine,
  viewed,
}: {
  readonly report: MachineHealthReport;
  readonly machine: MachineInfo;
  readonly viewed: EnvironmentPresentation;
}) {
  // Minute-level labels only; nothing repaints in between.
  const nowMs = useRelativeTimeTick(60_000);
  if (!report.reachable) {
    const sinceMs = machine.lastSeenAt === null ? null : DateTime.toEpochMillis(machine.lastSeenAt);
    return (
      <SettingsRow
        title={unreachableHeadline(report.machineName, sinceMs, nowMs)}
        description={`Showing what ${viewed.label} saw last. Wake ${report.machineName} up and make sure Cogenly is running there.`}
      />
    );
  }
  const meta = [
    `Checked ${isoLabel(report.observedAt)}`,
    `Version ${report.serverVersion}`,
    uptimeLabel(report.uptimeSeconds),
  ]
    .filter(Boolean)
    .join(" · ");
  return <SettingsRow title={healthHeadline(report)} description={meta} />;
}

/** Passing and unchecked checks, folded so problems stay in front. */
function OtherChecksRow({
  checks,
  context,
}: {
  readonly checks: ReadonlyArray<MachineHealthCheck>;
  readonly context: MachineHealthActionContext;
}) {
  const [open, setOpen] = useState(false);
  const unknown = checks.filter((check) => check.status === "unknown").length;
  const summary =
    unknown === 0
      ? checks.length === 1
        ? "1 check passing"
        : `${checks.length} checks passing`
      : `${checks.length - unknown} passing, ${unknown} couldn't run`;
  return (
    <SettingsRow
      title="Other checks"
      description={summary}
      control={
        <DisclosureTrigger
          variant="quiet"
          open={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide" : "Show"}
        </DisclosureTrigger>
      }
    >
      <DisclosurePanel open={open}>
        <ul className="space-y-3 pt-1 pb-2">
          {checks.map((check) => (
            <li key={check.id} className="space-y-2">
              <HealthLine
                status={check.status}
                title={HEALTH_CHECK_LABELS[check.id]}
                detail={check.summary}
              />
              {check.items.length > 0 ? (
                <ul className="space-y-3 ps-6.5">
                  {check.items.map((item) => (
                    <HealthItemRow key={item.key} item={item} context={context} />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </DisclosurePanel>
    </SettingsRow>
  );
}

const STATUS_ICONS = {
  ok: { icon: CheckCircle2Icon, className: "text-success" },
  warn: { icon: TriangleAlertIcon, className: "text-warning" },
  fail: { icon: CircleAlertIcon, className: "text-destructive" },
  unknown: { icon: CircleDashedIcon, className: "text-muted-foreground" },
} as const satisfies Record<MachineHealthStatus, { icon: LucideIcon; className: string }>;

/** A status glyph beside a title and its detail: one item, or one folded check. */
function HealthLine({
  status,
  title,
  detail,
  children,
}: {
  readonly status: MachineHealthStatus;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly children?: ReactNode;
}) {
  const marker = STATUS_ICONS[status];
  const Icon = marker.icon;
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <Icon
          aria-label={HEALTH_STATUS_LABELS[status]}
          className={cn("size-4", marker.className)}
        />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <div className="text-sm text-foreground">{title}</div>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function HealthItemRow({
  item,
  context,
}: {
  readonly item: MachineHealthItem;
  readonly context: MachineHealthActionContext;
}) {
  const { fix, open } = healthItemActions(item, context);
  const since =
    item.since === null || item.status === "ok" ? null : `since ${isoLabel(item.since)}`;
  return (
    <li>
      <HealthLine
        status={item.status}
        title={item.title}
        detail={[item.detail, since].filter(Boolean).join(" · ")}
      >
        {fix !== null || open !== null ? (
          <div className="flex flex-wrap gap-1.5">
            {fix !== null ? <HealthActionButton action={fix} primary subject={item.title} /> : null}
            {open !== null ? (
              <HealthActionButton action={open} primary={fix === null} subject={item.title} />
            ) : null}
          </div>
        ) : null}
      </HealthLine>
    </li>
  );
}

function HealthActionButton({
  action,
  primary,
  subject,
}: {
  readonly action: MachineHealthAction;
  readonly primary: boolean;
  readonly subject: string;
}) {
  const permitted = useAtomValue(machineHealthActionPermissionAtom(action));
  const run = useRunMachineHealthAction();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      disabled={!permitted || busy}
      aria-label={`${action.label}: ${subject}`}
      onClick={async () => {
        setBusy(true);
        try {
          await run(action);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {action.label}
    </Button>
  );
}

/** The hub's periodic end-to-end test, written to the hub's own settings. */
function CanaryRow({
  machine,
  list,
}: {
  readonly machine: MachineInfo;
  readonly list: MachineListResult;
}) {
  const hub = useEnvironment(machine.environmentId);
  const reachable = hub?.connection.phase === "connected";
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(machine.environmentId));
  const canWrite = useEnvironmentScope(machine.environmentId, AuthSettingsWriteScope);
  const update = useUpdateEnvironmentSettings(reachable ? machine.environmentId : null);
  const canary = settings?.health.canary ?? null;
  const editable = reachable && canWrite && canary !== null;
  const description =
    list.link._tag === "standalone"
      ? `Runs a short test on ${machine.name} on a schedule, so a broken provider or scheduler shows up before your agents need it.`
      : `Runs a short test on ${machine.name}, the always-on machine, on a schedule, so a broken provider or scheduler shows up before your agents need it.`;
  const blocked = !reachable
    ? `Connect to ${machine.name} in Settings → Connections to change this.`
    : !canWrite
      ? `This connection can't change settings on ${machine.name}.`
      : null;
  return (
    <SettingsRow
      {...searchableSetting("health-canary")}
      description={blocked === null ? description : `${description} ${blocked}`}
      control={
        <>
          {canary !== null ? (
            <Select
              value={String(canary.intervalMinutes)}
              disabled={!editable || !canary.enabled}
              onValueChange={(value) => {
                const intervalMinutes = Number(value);
                if (Number.isInteger(intervalMinutes)) {
                  update({ health: { canary: { intervalMinutes } } });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Canary interval">
                <SelectValue>
                  {
                    canaryIntervalOptions(canary.intervalMinutes).find(
                      (option) => option.minutes === canary.intervalMinutes,
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {canaryIntervalOptions(canary.intervalMinutes).map((option) => (
                  <SelectItem key={option.minutes} value={String(option.minutes)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Switch
            checked={canary?.enabled ?? false}
            disabled={!editable}
            aria-label={`Canary check on ${machine.name}`}
            onCheckedChange={(enabled) => update({ health: { canary: { enabled } } })}
          />
        </>
      }
    />
  );
}

/** Slack and email alerts for the viewed machine, all off until turned on. */
function AlertChannelRows({ environment }: { readonly environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useUpdateEnvironmentSettings(environmentId);
  const integrations =
    useEnvironmentQuery(integrationsRpc.list({ environmentId, input: {} })).data?.integrations ??
    [];
  const channels = settings?.health.alertChannels ?? null;
  if (channels === null) return null;
  const editable = canWrite && environment.connection.phase === "connected";
  const slackOptions = alertChannelIntegrations(integrations, "slack", channels.slack.integration);
  const emailOptions = alertChannelIntegrations(
    integrations,
    "google-workspace",
    channels.email.integration,
  );

  return (
    <>
      <SettingsRow
        {...searchableSetting("health-slack-alerts")}
        description={`Sends ${environment.label}'s alerts as a Slack direct message, through your connected Slack.`}
        control={
          <Switch
            checked={channels.slack.enabled}
            disabled={!editable}
            aria-label="Slack alerts"
            onCheckedChange={(enabled) =>
              update({
                health: {
                  alertChannels: {
                    slack: {
                      enabled,
                      // One connected Slack is the obvious choice.
                      ...(enabled &&
                      channels.slack.integration === null &&
                      slackOptions.length === 1
                        ? { integration: slackOptions[0]!.name }
                        : {}),
                    },
                  },
                },
              })
            }
          />
        }
      >
        <DisclosurePanel open={channels.slack.enabled}>
          <ChannelFields>
            <IntegrationField
              label="Slack workspace"
              catalogId="slack"
              environmentId={environmentId}
              options={slackOptions}
              value={channels.slack.integration}
              disabled={!editable}
              onChange={(integration) =>
                update({ health: { alertChannels: { slack: { integration } } } })
              }
            />
            <TextField
              label="Your member ID"
              hint="In Slack: your profile → ⋯ → Copy member ID."
              placeholder="U012ABCDEF"
              mono
              value={channels.slack.userId}
              disabled={!editable}
              onCommit={(userId) => update({ health: { alertChannels: { slack: { userId } } } })}
            />
          </ChannelFields>
        </DisclosurePanel>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("health-email-alerts")}
        description={`Emails ${environment.label}'s alerts from your connected Google Workspace account.`}
        control={
          <Switch
            checked={channels.email.enabled}
            disabled={!editable}
            aria-label="Email alerts"
            onCheckedChange={(enabled) =>
              update({
                health: {
                  alertChannels: {
                    email: {
                      enabled,
                      ...(enabled &&
                      channels.email.integration === null &&
                      emailOptions.length === 1
                        ? { integration: emailOptions[0]!.name }
                        : {}),
                    },
                  },
                },
              })
            }
          />
        }
      >
        <DisclosurePanel open={channels.email.enabled}>
          <ChannelFields>
            <IntegrationField
              label="Send from"
              catalogId="google-workspace"
              environmentId={environmentId}
              options={emailOptions}
              value={channels.email.integration}
              disabled={!editable}
              onChange={(integration) =>
                update({ health: { alertChannels: { email: { integration } } } })
              }
            />
            <TextField
              label="Send to"
              placeholder="you@example.com"
              type="email"
              value={channels.email.to}
              disabled={!editable}
              onCommit={(to) => update({ health: { alertChannels: { email: { to } } } })}
            />
          </ChannelFields>
        </DisclosurePanel>
      </SettingsRow>
      <TestAlertRow
        environmentId={environmentId}
        anyEnabled={channels.slack.enabled || channels.email.enabled}
      />
    </>
  );
}

function ChannelFields({ children }: { readonly children: ReactNode }) {
  return <div className="space-y-2.5 pt-1 pb-2">{children}</div>;
}

/** A label on the left and its control on the right, stacking on narrow rows. */
function ChannelField({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-start @min-[32rem]/settings-row:justify-between @min-[32rem]/settings-row:gap-8">
      <div className="min-w-0 space-y-0.5 pt-1">
        <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
          {label}
        </label>
        {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
      </div>
      <div className="flex w-full shrink-0 flex-col gap-1 @min-[32rem]/settings-row:w-56">
        {children}
      </div>
    </div>
  );
}

const NO_INTEGRATION = "__none__";

function IntegrationField({
  label,
  catalogId,
  environmentId,
  options,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly catalogId: IntegrationCatalogId;
  readonly environmentId: EnvironmentId;
  readonly options: ReturnType<typeof alertChannelIntegrations>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (integration: string | null) => void;
}) {
  const service = catalogId === "slack" ? "Slack" : "Google Workspace";
  if (options.length === 0) {
    return (
      <ChannelField label={label}>
        <p className="pt-1 text-xs text-muted-foreground">
          Connect {service} in{" "}
          <Link
            to="/settings/integrations"
            search={{ machine: environmentId }}
            hash="integration-services"
            className="link"
          >
            Settings → Integrations
          </Link>{" "}
          first.
        </p>
      </ChannelField>
    );
  }
  const selected = options.find((option) => option.name === value) ?? null;
  return (
    <ChannelField label={label}>
      <Select
        value={value ?? NO_INTEGRATION}
        disabled={disabled}
        onValueChange={(next) => onChange(next === NO_INTEGRATION ? null : String(next))}
      >
        <SelectTrigger size="sm" className="w-full" aria-label={label}>
          <SelectValue>{selected?.label ?? `Choose ${service}`}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={NO_INTEGRATION}>None</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.name} value={option.name}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {selected !== null && !selected.connected ? (
        <p className="text-xs text-warning-foreground">
          {selected.label} isn't connected right now, so alerts can't go out through it.
        </p>
      ) : null}
    </ChannelField>
  );
}

function TextField({
  label,
  hint,
  placeholder,
  type,
  mono = false,
  value,
  disabled,
  onCommit,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly placeholder: string;
  readonly type?: "email";
  readonly mono?: boolean;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onCommit: (value: string | null) => void;
}) {
  const id = useId();
  return (
    <ChannelField label={label} hint={hint} htmlFor={id}>
      <DraftInput
        id={id}
        size="sm"
        font={mono ? "mono" : "default"}
        {...(type === undefined ? {} : { type })}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value ?? ""}
        disabled={disabled}
        onCommit={(next) => {
          const trimmed = next.trim();
          const committed = trimmed.length > 0 ? trimmed : null;
          if (committed !== value) onCommit(committed);
        }}
      />
    </ChannelField>
  );
}

function TestAlertRow({
  environmentId,
  anyEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly anyEnabled: boolean;
}) {
  const test = useAtomCommand(machinesRpc.healthTestAlertChannels, { reportFailure: false });
  const canTest = useAtomValue(machinesRpc.healthTestAlertChannels.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MachineHealthChannelTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await test({ environmentId, input: {} });
      if (outcome._tag === "Success") {
        setResult(outcome.value);
      } else if (!isAtomCommandInterrupted(outcome)) {
        setResult(null);
        setError(
          failureMessage(squashAtomCommandFailure(outcome), "The test alert couldn't be sent."),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      title="Send test alert"
      description="Sends a test message through each channel that's on, so you know alerts will reach you."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!canTest || !anyEnabled || busy}
          onClick={() => void send()}
        >
          {busy ? <Spinner /> : null}
          Send test alert
        </Button>
      }
    >
      <AnimatedHeight>
        {error !== null ? (
          <p role="alert" className="pb-2 text-xs text-destructive">
            {error}
          </p>
        ) : result !== null ? (
          <ul className="space-y-2 pt-1 pb-2" role="status">
            {channelTestLines(result).map((line) => (
              <li key={line.channel}>
                <HealthLine
                  status={
                    line.state === "sent" ? "ok" : line.state === "failed" ? "fail" : "unknown"
                  }
                  title={line.channel}
                  detail={line.text}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </AnimatedHeight>
    </SettingsRow>
  );
}

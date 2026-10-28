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
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  healthItemActions,
  healthTargetAction,
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
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOpenMachineHealthAlerts } from "../../machines/machineHealthAlertsStore";
import { createIntegrationStatusFade } from "./integrationStatusMotion";
import { SettingsAttentionTitle } from "./SettingsAttentionTitle";
import {
  machineCheckAttention,
  worstTone,
  type SettingsAttentionTone,
} from "./settingsAttention.logic";
import {
  alertChannelIntegrations,
  canaryIntervalOptions,
  canaryMachineId,
  channelTestLines,
  HEALTH_CHECK_LABELS,
  HEALTH_STATUS_LABELS,
  HEALTH_STATUS_TONES,
  healthHeadline,
  machineHealthView,
  partitionHealthChecks,
  unreachableHeadline,
  uptimeLabel,
} from "./MachineHealthSection.logic";
import {
  SettingsDisclosureToggle,
  SettingsField,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SettingsStatusBadge, SettingsStatusDot } from "./SettingsStatus";

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
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
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
            supportsHealthFix={(id) =>
              serverConfigs.get(id)?.environment.capabilities.machineHealthFix === true
            }
            supportsTurnOffProvider={(id) =>
              serverConfigs.get(id)?.environment.capabilities.machineHealthTurnOffProvider === true
            }
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
        <SettingsStatusBadge tone="neutral">Connecting…</SettingsStatusBadge>
      ) : (
        <SettingsStatusBadge tone={HEALTH_STATUS_TONES[status]}>
          {HEALTH_STATUS_LABELS[status]}
        </SettingsStatusBadge>
      )}
    </span>
  );
}

/** A check's summary, dropped when its one item already says the same thing. */
function checkDescription(check: MachineHealthCheck): string | undefined {
  const [only, ...rest] = check.items;
  const repeated =
    only !== undefined &&
    rest.length === 0 &&
    only.title.trim().toLowerCase() === check.summary.trim().toLowerCase();
  return repeated ? undefined : check.summary;
}

function MachineHealthSection({
  viewed,
  machine,
  list,
  runsCanary,
  isConnected,
  supportsHealthFix,
  supportsTurnOffProvider,
}: {
  readonly viewed: EnvironmentPresentation;
  readonly machine: MachineInfo;
  readonly list: MachineListResult;
  readonly runsCanary: boolean;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly supportsHealthFix: (environmentId: EnvironmentId) => boolean;
  readonly supportsTurnOffProvider: (environmentId: EnvironmentId) => boolean;
}) {
  const isThis = machine.relation === "this";
  const query = useEnvironmentQuery(
    machinesRpc.health({
      environmentId: viewed.environmentId,
      input: isThis ? {} : { environmentId: machine.environmentId },
    }),
  );
  const report = query.data;
  // Coarse: only the end of the connect grace changes what this shows.
  const nowMs = useRelativeTimeTick(15_000);
  const view = machineHealthView({
    report,
    failed: query.error !== null,
    machine: {
      relation: machine.relation,
      online: machine.online,
      pairedAtMs: machine.pairedAt === null ? null : DateTime.toEpochMillis(machine.pairedAt),
      lastSeenAtMs: machine.lastSeenAt === null ? null : DateTime.toEpochMillis(machine.lastSeenAt),
    },
    nowMs,
  });
  // A report read while the machine was still offline is stale once it connects.
  const refreshReport = query.refresh;
  const wasOnline = useRef(machine.online);
  useEffect(() => {
    if (machine.online && !wasOnline.current) refreshReport();
    wasOnline.current = machine.online;
  }, [machine.online, refreshReport]);
  const overall: MachineHealthStatus | "connecting" | null =
    view._tag === "connecting" ? "connecting" : view._tag === "report" ? view.overall : null;
  const context: MachineHealthActionContext = {
    originEnvironmentId: machine.environmentId,
    originMachineName: machine.name,
    viaEnvironmentId: viewed.environmentId,
    isConnected,
    supportsHealthFix,
    supportsTurnOffProvider,
  };

  return (
    <SettingsSection
      id={machineHealthAnchorId(machine.environmentId)}
      title={`${machine.name} health`}
      headerAction={overall === null ? null : <StatusBadge status={overall} />}
    >
      {view._tag === "error" ? (
        <SettingsRow title={`Couldn't check ${machine.name}'s health`} description={query.error} />
      ) : view._tag === "checking" ? (
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <Spinner size="sm" tone="muted" />
              Checking {machine.name}…
            </span>
          }
          role="status"
        />
      ) : view._tag === "connecting" || report === null ? (
        <SettingsRow
          title={`Connecting to ${machine.name}…`}
          description="It hasn't checked in yet. This usually takes a few seconds."
          role="status"
        />
      ) : (
        <HealthReportRows
          report={report}
          unreachable={view.unreachable}
          machine={machine}
          viewed={viewed}
          context={context}
        />
      )}
      <AutoFixRow machine={machine} searchTarget={isThis} />
      {runsCanary ? <CanaryRow machine={machine} list={list} /> : null}
      {isThis ? <AlertChannelRows environment={viewed} /> : null}
    </SettingsSection>
  );
}

/** The summary row, the checks that need attention, then the rest behind a disclosure. */
function HealthReportRows({
  report,
  unreachable,
  machine,
  viewed,
  context,
}: {
  readonly report: MachineHealthReport;
  readonly unreachable: "offline" | "unanswered" | null;
  readonly machine: MachineInfo;
  readonly viewed: EnvironmentPresentation;
  readonly context: MachineHealthActionContext;
}) {
  // Unreachable reports contain a synthetic connection failure, which is stale
  // when the machine list already knows the peer is online.
  const { problems, others } = partitionHealthChecks(
    unreachable === "unanswered" ? [] : report.checks,
  );
  const arrived = useArrivedKeys(problems.map((check) => check.id));
  // The checks behind the rail's Settings dot, on this machine.
  const openAlerts = useOpenMachineHealthAlerts();
  const attention = machineCheckAttention(openAlerts, machine.environmentId);
  const othersAttention = worstTone(others.map((check) => attention.get(check.id)));
  return (
    <>
      <HealthSummaryRow
        report={report}
        unreachable={unreachable}
        machine={machine}
        viewed={viewed}
      />
      {/* The badge is the row's one status: no attention dot after the title. */}
      {problems.map((check) => (
        <SettingsRow
          key={check.id}
          className={arrived(check.id) ? ARRIVAL_FADE : undefined}
          title={HEALTH_CHECK_LABELS[check.id]}
          description={checkDescription(check)}
          control={<StatusBadge status={check.status} />}
        >
          <AnimatedHeight>
            {check.items.length > 0 ? (
              <ul className="space-y-3 pt-2">
                {check.items.map((item) => (
                  <HealthItemRow key={item.key} item={item} check={check} context={context} />
                ))}
              </ul>
            ) : null}
          </AnimatedHeight>
        </SettingsRow>
      ))}
      {others.length > 0 ? (
        <OtherChecksRow checks={others} context={context} attention={othersAttention} />
      ) : null}
    </>
  );
}

function HealthSummaryRow({
  report,
  unreachable,
  machine,
  viewed,
}: {
  readonly report: MachineHealthReport;
  readonly unreachable: "offline" | "unanswered" | null;
  readonly machine: MachineInfo;
  readonly viewed: EnvironmentPresentation;
}) {
  // Minute-level labels only; nothing repaints in between.
  const nowMs = useRelativeTimeTick(60_000);
  if (unreachable === "unanswered") {
    // Online in the machine list, so never "can't be reached".
    return (
      <SettingsRow
        title={`${report.machineName}'s health report hasn't arrived`}
        description={`${report.machineName} is connected. Its report should show here shortly.`}
      />
    );
  }
  if (unreachable === "offline") {
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
  attention,
}: {
  readonly checks: ReadonlyArray<MachineHealthCheck>;
  readonly context: MachineHealthActionContext;
  /** An open alert on a check folded in here. */
  readonly attention: SettingsAttentionTone | null;
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
      title={<SettingsAttentionTitle tone={attention}>Other checks</SettingsAttentionTitle>}
      description={summary}
      control={<SettingsDisclosureToggle open={open} onOpenChange={setOpen} label="other checks" />}
    >
      <DisclosurePanel open={open}>
        <ul className="space-y-3 pt-2">
          {checks.map((check) => (
            <li key={check.id} className="space-y-2">
              <HealthLine
                status={check.status}
                title={HEALTH_CHECK_LABELS[check.id]}
                detail={check.summary}
              />
              {check.items.length > 0 ? (
                // Indented past the check's dot, onto its title.
                <ul className="space-y-2 ps-3.5">
                  {check.items.map((item) => (
                    <HealthItemRow key={item.key} item={item} check={check} context={context} />
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

/**
 * One line under a health row: an item, one folded check, or a test send's
 * channel. Smaller than the row title, with its detail muted under it.
 * `status` puts a tone dot before the title; pass null when the row's own
 * badge already says it. `actions` sit on the row's trailing edge, under the
 * row's own control, and drop below the text on a narrow row.
 */
function HealthLine({
  status,
  title,
  detail,
  actions,
}: {
  readonly status: MachineHealthStatus | null;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex gap-2 text-xs">
      {status === null ? null : <SettingsStatusDot tone={HEALTH_STATUS_TONES[status]} />}
      <div className="flex min-w-0 flex-1 flex-col gap-2 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1">
          <div className="text-foreground">
            {status === null ? null : (
              <span className="sr-only">{HEALTH_STATUS_LABELS[status]}: </span>
            )}
            {title}
          </div>
          {detail ? <p className="text-muted-foreground">{detail}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 @min-[32rem]/settings-row:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One item of a check; it shows its own status only where it differs from the check's. */
function HealthItemRow({
  item,
  check,
  context,
}: {
  readonly item: MachineHealthItem;
  readonly check: MachineHealthCheck;
  readonly context: MachineHealthActionContext;
}) {
  // A passing line ("Canary passed") needs no Fix, only its link.
  const { fix, open, turnOff } =
    item.status === "ok"
      ? {
          fix: null,
          open: item.target === null ? null : healthTargetAction(item.target, context),
          turnOff: null,
        }
      : healthItemActions(
          {
            itemKey: item.key,
            checkId: check.id,
            title: item.title,
            detail: item.detail,
            fix: item.fix,
            target: item.target,
          },
          context,
        );
  const since =
    item.since === null || item.status === "ok" ? null : `since ${isoLabel(item.since)}`;
  return (
    <li>
      <HealthLine
        status={item.status === check.status ? null : item.status}
        title={item.title}
        detail={[item.detail, since].filter(Boolean).join(" · ")}
        actions={
          fix !== null || open !== null || turnOff !== null ? (
            <>
              {turnOff !== null ? (
                <HealthActionButton action={turnOff} primary={false} subject={item.title} />
              ) : null}
              {open !== null ? (
                <HealthActionButton action={open} primary={fix === null} subject={item.title} />
              ) : null}
              {fix !== null ? (
                <HealthActionButton action={fix} primary subject={item.title} />
              ) : null}
            </>
          ) : null
        }
      />
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
      size="sm"
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

/** Whether a machine runs its safe fixes itself, written to that machine's own settings. */
function AutoFixRow({
  machine,
  searchTarget,
}: {
  readonly machine: MachineInfo;
  /** Every machine has the row; search lands on this machine's. */
  readonly searchTarget: boolean;
}) {
  const environment = useEnvironment(machine.environmentId);
  const reachable = environment?.connection.phase === "connected";
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(machine.environmentId));
  const canWrite = useEnvironmentScope(machine.environmentId, AuthSettingsWriteScope);
  const update = useUpdateEnvironmentSettings(reachable ? machine.environmentId : null);
  const autoFix = settings?.health.autoFix ?? null;
  const description = `${machine.name} retries stuck sync and stops runs that lost their provider session on its own. You hear about these only when a fix fails.`;
  const blocked = !reachable
    ? `Connect to ${machine.name} in Settings → Connections to change this.`
    : !canWrite
      ? `This connection can't change settings on ${machine.name}.`
      : null;
  return (
    <SettingsRow
      {...(searchTarget
        ? searchableSetting("health-auto-fix")
        : { title: searchableSetting("health-auto-fix").title })}
      description={blocked === null ? description : `${description} ${blocked}`}
      control={
        <Switch
          checked={autoFix ?? false}
          disabled={!reachable || !canWrite || autoFix === null}
          aria-label={`Fix problems automatically on ${machine.name}`}
          onCheckedChange={(enabled) => update({ health: { autoFix: enabled } })}
        />
      }
    />
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
        <Switch
          checked={canary?.enabled ?? false}
          disabled={!editable}
          aria-label={`Canary check on ${machine.name}`}
          onCheckedChange={(enabled) => update({ health: { canary: { enabled } } })}
        />
      }
    >
      {canary !== null ? (
        <DisclosurePanel open={canary.enabled}>
          <ChannelFields>
            <ChannelField label="Runs">
              <Select
                value={String(canary.intervalMinutes)}
                disabled={!editable}
                onValueChange={(value) => {
                  const intervalMinutes = Number(value);
                  if (Number.isInteger(intervalMinutes)) {
                    update({ health: { canary: { intervalMinutes } } });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="Canary interval">
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
            </ChannelField>
          </ChannelFields>
        </DisclosurePanel>
      ) : null}
    </SettingsRow>
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
  return <div className="space-y-2.5 pt-2">{children}</div>;
}

/**
 * A label (and any hint or warning under it) on the left, its control on the
 * right at the settings field width, stacking on narrow rows.
 */
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
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <SettingsField>{children}</SettingsField>
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
    <ChannelField
      label={label}
      hint={
        selected !== null && !selected.connected ? (
          <span className="text-warning-foreground">
            {selected.label} isn't connected right now, so alerts can't go out through it.
          </span>
        ) : undefined
      }
    >
      <Select
        value={value ?? NO_INTEGRATION}
        disabled={disabled}
        onValueChange={(next) => onChange(next === NO_INTEGRATION ? null : String(next))}
      >
        <SelectTrigger size="sm" aria-label={label}>
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

  // Why the button is off, since a disabled button can't say so itself.
  const blocked = !canTest
    ? "This connection can't send test alerts."
    : !anyEnabled
      ? "Turn on Slack or email alerts first."
      : null;
  const button = (
    <Button
      size="sm"
      variant="outline"
      disabled={blocked !== null || busy}
      onClick={() => void send()}
    >
      {busy ? <Spinner /> : null}
      Send test
    </Button>
  );

  return (
    <SettingsRow
      title="Test alerts"
      description="Sends a test message through each channel that's on, so you know alerts will reach you."
      control={
        blocked === null ? (
          button
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                // Focusable so keyboard users can still reach the reason.
                <span
                  tabIndex={0}
                  className="flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              {button}
            </TooltipTrigger>
            <TooltipPopup side="top">{blocked}</TooltipPopup>
          </Tooltip>
        )
      }
    >
      <AnimatedHeight>
        {error !== null ? (
          <p role="alert" className="pt-2 text-xs text-destructive">
            {error}
          </p>
        ) : result !== null ? (
          <ul className="space-y-2 pt-2" role="status">
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

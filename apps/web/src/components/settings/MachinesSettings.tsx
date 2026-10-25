import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MachineInfo,
  MachineListResult,
  MachineSetupStatus,
  MachineSetupStep,
} from "@cogenly/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  ExternalLinkIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import { requestConfirmDialog } from "../../confirmDialog";
import { ensureLocalApi } from "../../localApi";
import { machinesRpc } from "../../rpc/machines";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { CopyableValue } from "./CopyableValue";
import { useStatusFade } from "./integrationStatusMotion";
import { createIntegrationStatusFade } from "./integrationStatusMotion";
import { MachineHealthSections } from "./MachineHealthSection";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const TAILSCALE_SENTENCE =
  "Cogenly links your machines through Tailscale, a free app that gives them a private, encrypted connection only you can use.";
const TERMINAL_STEPS_URL =
  "https://github.com/aflekkas/cogenly/blob/main/docs/user/machines.md#pair-from-the-terminal";
const READ_ONLY_MESSAGE =
  "This connection can see machines but can't add or unpair them. Reconnect with full access to change pairing.";

/** Opens a link: the system browser on desktop, a new tab on the web. */
function openInBrowser(url: string) {
  if (window.desktopBridge) void ensureLocalApi().shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function machineKindLabel(machine: MachineInfo): string {
  if (machine.kind === "cloud-server") return "Cloud server";
  switch (machine.hardware) {
    case "laptop":
      return "Laptop";
    case "desktop":
      return "Desktop";
    case "server":
      return "Server";
  }
}

function hubNameIn(list: MachineListResult): string {
  if (list.link._tag !== "spoke") return "the always-on machine";
  const { hubEnvironmentId } = list.link;
  return (
    list.machines.find((machine) => machine.environmentId === hubEnvironmentId)?.name ??
    "the always-on machine"
  );
}

/** Where the viewed machine stands: alone, the always-on machine, or paired with one. */
function roleText(list: MachineListResult): string {
  const { link } = list;
  switch (link._tag) {
    case "standalone":
      return "Not paired with another machine yet.";
    case "hub":
      return link.spokes === 1
        ? "The always-on machine for 1 other machine."
        : `The always-on machine for ${link.spokes} other machines.`;
    case "spoke": {
      const hub = hubNameIn(list);
      switch (link.status) {
        case "connecting":
          return `Paired with ${hub}. Connecting…`;
        case "online":
          return `Paired with ${hub}. Connected.`;
        case "offline":
          return `Paired with ${hub}, which can't be reached right now.${link.lastError ? ` ${link.lastError}` : ""}`;
        case "revoked":
          return `${hub} unpaired this machine. Unpair here to finish.`;
        case "untrusted":
          return `${hub} couldn't prove it's the same machine. Unpair, then pair again.`;
      }
    }
  }
}

function relationText(machine: MachineInfo, list: MachineListResult): string {
  switch (machine.relation) {
    case "this":
      return roleText(list);
    case "hub":
      return "The always-on machine this one syncs with.";
    case "spoke":
      return "Syncs with this machine.";
    case "peer":
      return `Also syncs with ${hubNameIn(list)}.`;
  }
}

/**
 * Settings → Machines: the viewed machine's pairing, every machine it knows
 * about, and Add a machine, which walks both machines through Tailscale and
 * pairs them. Unpair is the way back out.
 */
export function MachinesSettingsPanel({
  addRequested,
  onAddOpened,
}: {
  /** A link asked for Add a machine, such as the command palette's; `onAddOpened` consumes it. */
  readonly addRequested: boolean;
  readonly onAddOpened: () => void;
}) {
  const { environment } = useSettingsScope();
  const [adding, setAdding] = useState(false);
  if (addRequested && !adding) setAdding(true);
  useEffect(() => {
    if (addRequested) onAddOpened();
  }, [addRequested, onAddOpened]);

  return (
    <SettingsPageContainer>
      <MachinesSection environment={environment} onAdd={() => setAdding(true)} />
      <MachineHealthSections environment={environment} />
      <OverlayPresence when={adding ? environment : null}>
        {(viewed) => <AddMachineDialog viewed={viewed} onClose={() => setAdding(false)} />}
      </OverlayPresence>
    </SettingsPageContainer>
  );
}

function MachinesSection({
  environment,
  onAdd,
}: {
  readonly environment: EnvironmentPresentation | null;
  readonly onAdd: () => void;
}) {
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : machinesRpc.list({ environmentId, input: {} }),
  );
  const canPair = useAtomValue(machinesRpc.pairWith.permissionAtom(environmentId));
  const canUnpair = useAtomValue(machinesRpc.unpair.permissionAtom(environmentId));
  const setup = useMachineSetup(environment);
  const list = query.data;

  return (
    <SettingsSection
      {...searchableSetting("machines")}
      headerAction={
        canPair ? (
          <Button size="xs" variant="outline" onClick={onAdd}>
            <PlusIcon />
            Add a machine
          </Button>
        ) : null
      }
    >
      {environment === null ? (
        <SettingsRow title="Choose a machine to see its pairing." />
      ) : query.error !== null && list === null ? (
        <SettingsRow
          title={`Couldn't load ${environment.label}'s machines`}
          description={query.error}
        />
      ) : list === null ? (
        <SettingsRow title="Loading machines…" role="status" />
      ) : (
        list.machines
          .toSorted(
            (left, right) => Number(right.relation === "this") - Number(left.relation === "this"),
          )
          .map((machine) => (
            <MachineRow
              key={machine.environmentId}
              environmentId={environment.environmentId}
              viewedName={environment.label}
              machine={machine}
              list={list}
              canUnpair={canUnpair}
              setup={machine.relation === "this" ? setup : null}
            />
          ))
      )}
      {environment !== null && !canPair ? (
        <SettingsRow title="Pairing" description={READ_ONLY_MESSAGE} />
      ) : null}
    </SettingsSection>
  );
}

function MachineRow({
  environmentId,
  viewedName,
  machine,
  list,
  canUnpair,
  setup,
}: {
  readonly environmentId: EnvironmentId;
  readonly viewedName: string;
  readonly machine: MachineInfo;
  readonly list: MachineListResult;
  readonly canUnpair: boolean;
  readonly setup: MachineSetupView | null;
}) {
  const unpair = useAtomCommand(machinesRpc.unpair, { reportFailure: false });
  const disableServe = useAtomCommand(machinesRpc.disableServe, { reportFailure: false });
  const runStep = useAtomCommand(machinesRpc.runStep, { reportFailure: false });
  const canPrivateAccess = useAtomValue(machinesRpc.disableServe.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [privateBusy, setPrivateBusy] = useState(false);
  const isThis = machine.relation === "this";
  // A peer is paired with the hub, not with this machine; unpair it there.
  const unpairable = !isThis && machine.relation !== "peer" && machine.pairing !== "self";
  const presence = isThis
    ? null
    : machine.pairing === "revoked"
      ? "Unpaired on the other side"
      : machine.online
        ? "Online"
        : "Offline";
  const statusNode = useStatusFade<HTMLDivElement>(presence ?? "");
  const lastSeen =
    !isThis && !machine.online && machine.lastSeenAt !== null
      ? `Last seen ${formatRelativeTimeLabel(DateTime.formatIso(machine.lastSeenAt))}`
      : null;
  const description = [machineKindLabel(machine), relationText(machine, list), lastSeen]
    .filter(Boolean)
    .join(" · ");

  const unpairNow = async () => {
    const message = `Unpair ${machine.name}?\nIt stops syncing with ${viewedName}. Projects and conversations stay on both machines.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await unpair({
        environmentId,
        input: { environmentId: machine.environmentId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Couldn't unpair ${machine.name}`,
          description: failureMessage(squashAtomCommandFailure(result), "Try again in a moment."),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const served = setup?.status?.tailscale.served ?? null;
  const setPrivateAccess = async (checked: boolean) => {
    if (!checked) {
      const spokes = list.link._tag === "hub" ? list.link.spokes : 0;
      const message =
        spokes > 0
          ? `Turn off private access for ${machine.name}?\n${spokes === 1 ? "1 paired machine" : `${spokes} paired machines`} will disconnect until you turn it back on.`
          : `Turn off private access for ${machine.name}?\nOther machines won't be able to reach it until you turn it back on.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setPrivateBusy(true);
    try {
      const result = checked
        ? await runStep({ environmentId, input: { step: "expose" } })
        : await disableServe({ environmentId, input: {} });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: checked
            ? `Couldn't turn on private access for ${machine.name}`
            : `Couldn't turn off private access for ${machine.name}`,
          description: failureMessage(squashAtomCommandFailure(result), "Try again in a moment."),
        });
      }
    } finally {
      setPrivateBusy(false);
    }
  };

  return (
    <SettingsRow
      title={isThis ? `${machine.name} (this machine)` : machine.name}
      description={description}
      control={
        isThis ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Private access</span>
            <Switch
              checked={served === true}
              disabled={!canPrivateAccess || setup?.status === null || privateBusy}
              aria-label={`Private access for ${machine.name}`}
              onCheckedChange={(checked) => void setPrivateAccess(checked)}
            />
            {privateBusy ? <Spinner /> : null}
          </div>
        ) : (
          <>
            <div ref={statusNode} className="flex">
              {presence === null ? null : (
                <Badge
                  size="sm"
                  variant={
                    presence === "Online"
                      ? "success"
                      : presence === "Offline"
                        ? "outline"
                        : "warning"
                  }
                >
                  {presence}
                </Badge>
              )}
            </div>
            {unpairable && canUnpair ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void unpairNow()}
              >
                {busy ? <Spinner /> : null}
                Unpair
              </Button>
            ) : null}
          </>
        )
      }
    />
  );
}

interface MachineSetupView {
  readonly reachable: boolean;
  readonly canWrite: boolean;
  readonly status: MachineSetupStatus | null;
  readonly error: string | null;
}

/** One machine's live setup status, while its connection is up and may manage access. */
function useMachineSetup(environment: EnvironmentPresentation | null): MachineSetupView {
  const environmentId = environment?.environmentId ?? null;
  // Reading setup needs the same access:write grant as running its steps.
  const canWrite = useAtomValue(machinesRpc.runStep.permissionAtom(environmentId));
  const reachable = environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    environmentId !== null && reachable && canWrite
      ? machinesRpc.setup({ environmentId, input: {} })
      : null,
  );
  return {
    reachable,
    canWrite,
    // A status from before the connection dropped would be stale.
    status: reachable ? query.data : null,
    error: reachable ? query.error : null,
  };
}

function AddMachineDialog({
  viewed,
  onClose,
}: {
  readonly viewed: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const viewedList = useEnvironmentQuery(
    machinesRpc.list({ environmentId: viewed.environmentId, input: {} }),
  ).data;
  const link = viewedList?.link ?? null;
  // A machine that already joined one can't be a hub; new machines join its hub.
  const hubId = link?._tag === "spoke" ? link.hubEnvironmentId : viewed.environmentId;
  const hub = environments.find((environment) => environment.environmentId === hubId) ?? null;
  const hubName = hub?.label ?? (viewedList ? hubNameIn(viewedList) : viewed.label);
  const hubList = useEnvironmentQuery(
    hub === null ? null : machinesRpc.list({ environmentId: hub.environmentId, input: {} }),
  ).data;
  const alreadyPaired = new Set(
    (hubList?.machines ?? [])
      .filter((machine) => machine.pairing === "paired")
      .map((machine) => machine.environmentId),
  );
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId !== hubId && !alreadyPaired.has(environment.environmentId),
  );
  const [pickedId, setPickedId] = useState<EnvironmentId | null>(null);
  const spoke =
    candidates.find((environment) => environment.environmentId === pickedId) ??
    candidates[0] ??
    null;

  const hubSetup = useMachineSetup(hub);
  const spokeSetup = useMachineSetup(spoke);
  const canPair =
    useAtomValue(machinesRpc.pairWith.permissionAtom(spoke?.environmentId ?? null)) &&
    hubSetup.canWrite;
  const pair = useAtomCommand(machinesRpc.pairWith, { reportFailure: false });
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const bothReady =
    hubSetup.reachable &&
    spokeSetup.reachable &&
    hubSetup.status?.ready === true &&
    spokeSetup.status?.ready === true;

  const pairNow = async () => {
    if (hub === null || spoke === null) return;
    setPairing(true);
    setPairError(null);
    try {
      // The join code passes between the machines inside this one command.
      const result = await pair({
        environmentId: spoke.environmentId,
        input: { hubEnvironmentId: hub.environmentId, hubName },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Paired. ${spoke.label} now syncs with ${hubName}.`,
        });
        onClose();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        setPairError(
          failureMessage(squashAtomCommandFailure(result), "Pairing didn't finish. Try again."),
        );
      }
    } finally {
      setPairing(false);
    }
  };

  const body = (() => {
    if (viewedList === null) {
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner size="sm" tone="muted" />
          Checking {viewed.label}…
        </p>
      );
    }
    if (hub === null) {
      return (
        <p className="text-sm text-muted-foreground">
          {viewed.label} is already paired with {hubName}, so new machines pair with {hubName}.
          Connect to {hubName} in{" "}
          <Link to="/settings/connections" className="link">
            Settings → Connections
          </Link>{" "}
          first, then add machines from there.
        </p>
      );
    }
    if (spoke === null) {
      return (
        <p className="text-sm text-muted-foreground">
          Connect to the other machine in{" "}
          <Link to="/settings/connections" className="link">
            Settings → Connections
          </Link>{" "}
          first, then come back here. Or{" "}
          <InlineButton onClick={() => openInBrowser(TERMINAL_STEPS_URL)}>
            pair from the terminal
          </InlineButton>
          .
        </p>
      );
    }
    return (
      <div className="space-y-4">
        {hub.environmentId !== viewed.environmentId ? (
          <p className="text-sm text-muted-foreground">
            {viewed.label} is paired with {hubName}, so new machines pair with {hubName}.
          </p>
        ) : null}
        {candidates.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Machine to add</span>
            <Select
              value={spoke.environmentId}
              onValueChange={(value) => {
                const next = candidates.find((environment) => environment.environmentId === value);
                if (next) {
                  setPickedId(next.environmentId);
                  setPairError(null);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Machine to add">
                <SelectValue>{spoke.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {candidates.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <SetupChecklist
            environmentId={hub.environmentId}
            name={hubName}
            role="Always on"
            setup={hubSetup}
          />
          <SetupChecklist
            key={spoke.environmentId}
            environmentId={spoke.environmentId}
            name={spoke.label}
            role="Joining"
            setup={spokeSetup}
          />
        </div>
        <AnimatedHeight>
          {pairError ? (
            <p role="alert" className="text-sm text-destructive">
              {pairError}
            </p>
          ) : null}
        </AnimatedHeight>
      </div>
    );
  })();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pairing) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>{TAILSCALE_SENTENCE}</DialogDescription>
        </DialogHeader>
        <DialogPanel>{body}</DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />} disabled={pairing}>
            Cancel
          </DialogClose>
          {hub !== null && spoke !== null ? (
            <Button disabled={!bothReady || !canPair || pairing} onClick={() => void pairNow()}>
              {pairing ? <Spinner /> : null}
              {pairing ? `Pairing ${spoke.label}…` : `Pair ${spoke.label} with ${hubName}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** One machine's steps, live from its own server. */
function SetupChecklist({
  environmentId,
  name,
  role,
  setup,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly role: string;
  readonly setup: MachineSetupView;
}) {
  // Open-url steps finish by themselves once the user is done on that page.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const { status } = setup;
  const content = !setup.reachable ? (
    <p className="text-sm text-muted-foreground">
      Can't reach {name}. Wake it up and make sure Cogenly is open.
    </p>
  ) : !setup.canWrite ? (
    <p className="text-sm text-muted-foreground">
      This connection can't set up {name}. Reconnect to it with full access in Settings →
      Connections.
    </p>
  ) : setup.error !== null && status === null ? (
    <p className="text-sm text-destructive">
      Couldn't check {name}. {setup.error}
    </p>
  ) : status === null ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Spinner size="sm" tone="muted" />
      Checking {name}…
    </p>
  ) : (
    <div className="space-y-3">
      <ol className="space-y-3">
        {status.steps.map((step) => (
          <SetupStepRow
            key={step.id}
            environmentId={environmentId}
            name={name}
            step={step}
            opened={opened.has(step.id)}
            onOpened={() => setOpened((current) => new Set(current).add(step.id))}
          />
        ))}
      </ol>
      <AnimatedHeight>
        {status.problem ? (
          <p role="alert" className="text-xs text-destructive">
            {status.problem}
          </p>
        ) : status.ready ? (
          <p className="text-xs text-success-foreground">{name} is ready.</p>
        ) : null}
      </AnimatedHeight>
    </div>
  );

  return (
    <section
      aria-label={`${name} setup`}
      className="space-y-3 rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="truncate text-sm font-medium text-foreground">{name}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">{role}</span>
      </header>
      {content}
    </section>
  );
}

const STEP_ICONS = {
  done: { icon: CheckCircle2Icon, label: "Done" },
  todo: { icon: CircleIcon, label: "To do" },
  waiting: { icon: ClockIcon, label: "Waiting" },
  blocked: { icon: CircleDashedIcon, label: "Not yet" },
} as const;

function SetupStepRow({
  environmentId,
  name,
  step,
  opened,
  onOpened,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly step: MachineSetupStep;
  readonly opened: boolean;
  readonly onOpened: () => void;
}) {
  const runStep = useAtomCommand(machinesRpc.runStep, { reportFailure: false });
  const canRun = useAtomValue(machinesRpc.runStep.permissionAtom(environmentId));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state =
    step.state === "todo" && opened && step.handoff?._tag === "open-url" ? "waiting" : step.state;
  const row = useStatusFade<HTMLLIElement>(state);
  const actionable = state === "todo" || state === "waiting";
  const { handoff } = step;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await runStep({ environmentId, input: { step: step.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(failureMessage(squashAtomCommandFailure(result), `Couldn't do this on ${name}.`));
      }
    } finally {
      setStarting(false);
    }
  };

  const marker = state === "working" ? null : STEP_ICONS[state];
  const Icon = marker?.icon;
  return (
    <li ref={row} className="flex gap-2.5">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {marker === null || Icon === undefined ? (
          <Spinner size="md" tone="muted" />
        ) : (
          <Icon
            aria-label={marker.label}
            className={
              state === "done"
                ? "size-4 text-success"
                : state === "blocked"
                  ? "size-4 text-muted-foreground/60"
                  : "size-4 text-muted-foreground"
            }
          />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <div
            className={
              state === "blocked" ? "text-sm text-muted-foreground" : "text-sm text-foreground"
            }
          >
            {step.title}
          </div>
          <p className="text-xs text-muted-foreground">{step.detail}</p>
        </div>
        {actionable && (step.action !== null || handoff !== null) ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {step.action !== null ? (
                <Button
                  size="xs"
                  disabled={!canRun || starting}
                  aria-label={`${step.action} on ${name}`}
                  onClick={() => void start()}
                >
                  {starting ? <Spinner /> : null}
                  {step.action}
                </Button>
              ) : null}
              {handoff?._tag === "open-url" ? (
                <Button
                  size="xs"
                  variant={step.action === null ? "default" : "outline"}
                  aria-label={`${handoff.label} for ${name}`}
                  onClick={() => {
                    openInBrowser(handoff.url);
                    onOpened();
                  }}
                >
                  <ExternalLinkIcon />
                  {handoff.label}
                </Button>
              ) : null}
            </div>
            {handoff?._tag === "run-command" ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{handoff.reason}</p>
                <CopyableValue value={handoff.command} label="Command" />
              </div>
            ) : null}
            <AnimatedHeight>
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </AnimatedHeight>
          </div>
        ) : null}
      </div>
    </li>
  );
}

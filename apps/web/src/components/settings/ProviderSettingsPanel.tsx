import { OverlayPresence } from "~/components/ui/overlay-presence";
import { SettingsGroup } from "./SettingsGroup";
import {
  SETTINGS_MASTER_DETAIL_HEIGHT,
  SettingsMasterDetail,
  SettingsMasterDetailAddRow,
  SettingsMasterDetailEditor,
} from "./SettingsMasterDetail";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
} from "@cogenly/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@cogenly/client-runtime/connection";
import { safeErrorLogAttributes } from "@cogenly/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveEnvironmentMachineKind,
  resolveProviderInstanceEnabled,
} from "@cogenly/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cogenly/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@cogenly/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
  useUpdateEnvironmentModelPreferences,
} from "../../hooks/useSettings";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { resolveProviderInstanceAccentColors } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  type ProviderSettingsUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatesAction } from "../ProviderUpdatesAction";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ExpandableText } from "./ExpandableText";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderMachineSignIns } from "./ProviderMachineSignIns";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { CodexSetupSection, CodexManagedRuntimeFields } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsNumberField,
  SettingsRefreshAction,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

/** Models whose membership differs between two lists. */
function modelListChanges(current: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const nextSet = new Set(next.map((model) => model.trim()).filter(Boolean));
  return [...new Set([...currentSet, ...nextSet])].filter(
    (model) => currentSet.has(model) !== nextSet.has(model),
  );
}

const PROVIDER_SETTINGS = providerClients.definitions.map((definition) => ({
  provider: definition.driverKind,
  hasDefaultInstance: definition.hasDefaultInstance !== false,
}));

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary machine";
  if (environment.relayManaged) return "Cogenly Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local machine";
  return environment.displayUrl ?? "Remote machine";
}

const providerCardHeightClassName = SETTINGS_MASTER_DETAIL_HEIGHT.page;

/**
 * Same chrome as the provider editor (section heading, floating machine tabs,
 * tall card) for states that cannot render provider settings yet.
 */
function ProviderSettingsPlaceholder({
  machineTabs,
  icon,
  title,
  description,
  children,
}: {
  readonly machineTabs?: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {machineTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{machineTabs}</div>
      ) : null}
      <SettingsGroup
        divided={false}
        className={cn(
          providerCardHeightClassName,
          "scroll-fade-y scrollbar-gutter-both flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty>
          <EmptyMedia>{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </SettingsGroup>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  environment,
  access,
  machineTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly machineTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading provider settings"
    : access.kind === "error"
      ? "Could not connect to this machine"
      : "Provider settings are unavailable";
  // Keep the description to a short status; the raw failure can be a
  // multi-paragraph CLI dump, so it goes below, clamped and expandable.
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // No spinner: this state can persist indefinitely for a wedged machine, and a
  // continuously repainting animation would run the whole time.
  return (
    <ProviderSettingsPlaceholder
      machineTabs={machineTabs}
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

interface ProviderSettingsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
}

export function ProviderSettingsPanel(target: ProviderSettingsTarget) {
  return (
    <>
      <ProviderSettingsPanelContent
        key={`${target.environmentId ?? ""}:${target.instanceId ?? ""}`}
        {...target}
      />
    </>
  );
}

function ProviderSettingsPanelContent(target: ProviderSettingsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchTargetId = useSettingsSearchTargetId();
  const options = useMemo(
    () =>
      buildProviderEnvironmentOptions(environments, primaryEnvironmentId, target.environmentIds),
    [environments, primaryEnvironmentId, target.environmentIds],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // machine that drops out of the catalog falls back without erasing the pick;
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    target.environmentId ?? primaryEnvironmentId,
  );
  const targetEnvironmentMissing =
    target.environmentId !== undefined &&
    selectedEnvironmentId === target.environmentId &&
    !options.some((environment) => environment.environmentId === target.environmentId);
  const effectiveEnvironmentId =
    target.scoped || targetEnvironmentMissing
      ? target.environmentId
      : resolveSelectedProviderEnvironmentId(options, selectedEnvironmentId, primaryEnvironmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const selectedEnvironmentCanRenderSettings =
    selectedEnvironment !== null &&
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: selectedEnvironment.connection.phase,
      hasServerConfig: selectedEnvironment.serverConfig !== null,
    });
  const searchableEnvironmentId = options.find((environment) =>
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: environment.connection.phase,
      hasServerConfig: environment.serverConfig !== null,
    }),
  )?.environmentId;
  useEffect(() => {
    if (
      !target.scoped &&
      searchTargetId === searchableSetting("provider-health-check-interval").id &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      setSelectedEnvironmentId(searchableEnvironmentId);
    }
  }, [
    searchTargetId,
    searchableEnvironmentId,
    selectedEnvironment,
    selectedEnvironmentCanRenderSettings,
    target.scoped,
  ]);
  const onlyPrimaryMachine =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const machineTabs =
    !target.scoped && !onlyPrimaryMachine && options.length > 0 ? (
      <ScrollArea radius="none" hideScrollbars scrollFade className="h-11 min-w-0 flex-1">
        <ToggleGroup
          aria-label="Machines"
          variant="segmented"
          className="my-2"
          value={effectiveEnvironmentId ? [effectiveEnvironmentId] : []}
          onValueChange={(next) => {
            const environment = options.find((option) => option.environmentId === next[0]);
            if (environment) setSelectedEnvironmentId(environment.environmentId);
          }}
        >
          {options.map((environment) => {
            const machine = resolveEnvironmentMachineKind(environment.serverConfig);
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusTitle(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <Toggle value={environment.environmentId}>
                      <EnvironmentMachineIcon
                        kind={machine}
                        className="size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </Toggle>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </ScrollArea>
    ) : null;

  return (
    <>
      {targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          machineTabs={machineTabs}
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title="Machine unavailable"
          description="Reconnect this machine to set up its provider, or select another machine."
        />
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={isReady ? "No connected machines" : "Loading machines"}
          description={
            isReady
              ? "Connect a machine before configuring providers."
              : "Reading connected machines."
          }
        />
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          machineTabs={machineTabs}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
        />
      ) : null}
    </>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  machineTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly machineTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  return (
    <RemoteSessionGatedProviderSettings
      environment={environment}
      machineTabs={machineTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  machineTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly machineTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      machineTabs={machineTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  machineTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly machineTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailablePlaceholder
        environment={environment}
        access={access}
        machineTabs={machineTabs}
      />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      machineTabs={machineTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  machineTabs,
  targetInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly machineTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  /**
   * Grey out and freeze every write control when this session's credential
   * lacks `providers:manage` on the environment. Selecting providers
   * still works so the real configuration stays readable; switches, forms,
   * are inert so no write is offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRefreshProviders = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateModelPreferences = useUpdateEnvironmentModelPreferences(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    targetInstanceId ?? null,
  );
  const [updatingProviderInstanceIds, setUpdatingProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingInstanceIdsRef = useRef<Set<ProviderInstanceId>>(new Set());

  const providerUpdateCandidateByInstanceId = useMemo(
    () =>
      new Map(
        serverProviders
          .filter(isProviderSettingsUpdateCandidate)
          .map((candidate) => [candidate.instanceId, candidate]),
      ),
    [serverProviders],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS;
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current || !readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
      return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: { refreshModels: true },
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (
      candidate: Pick<ProviderSettingsUpdateCandidate, "driver" | "instanceId">,
      targetVersion?: string,
    ) => {
      if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
      if (updatingInstanceIdsRef.current.has(candidate.instanceId)) {
        return;
      }
      updatingInstanceIdsRef.current.add(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => new Set(previous).add(candidate.instanceId));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
          ...(targetVersion ? { targetVersion } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider update command could not be started.",
          }),
        );
      }
      updatingInstanceIdsRef.current.delete(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => {
        if (!previous.has(candidate.instanceId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.instanceId);
        return next;
      });
    },
    [environmentId, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // An unconfigured default slot runs with the driver's default config.
    const effectiveInstance: ProviderInstanceConfig = explicitInstance ?? { driver };
    const isDirty = explicitInstance !== undefined;
    // Drivers without a default instance list only their configured instances.
    const hasDefaultSlot = providerSettings.hasDefaultInstance || explicitInstance !== undefined;
    if (
      hasDefaultSlot &&
      (providerSettings.hasDefaultInstance ||
        isDirty ||
        resolveProviderInstanceEnabled(effectiveInstance) ||
        defaultInstanceId === targetInstanceId)
    ) {
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  // The same marks the model picker shows, from settings so a color change
  // shows here before the provider snapshot catches up.
  const markColorByInstanceId = resolveProviderInstanceAccentColors(
    rows.map((row) => ({
      instanceId: row.instanceId,
      driver: row.driver,
      accentColor: row.instance.accentColor,
    })),
  );

  const targetInstanceMissing =
    targetInstanceId !== undefined &&
    selectedInstanceId === targetInstanceId &&
    !rows.some((row) => row.instanceId === targetInstanceId);
  const selectedRow =
    rows.find((row) => row.instanceId === selectedInstanceId) ??
    (targetInstanceMissing ? null : (rows[0] ?? null));

  const updateProviderInstance = async (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    const { providerInstances: _providerInstances, ...patch } = buildProviderInstanceUpdatePatch({
      settings,
      instanceId: row.instanceId,
      instance: next,
      textGenerationModelSelection: options?.textGenerationModelSelection,
    });
    const result = await persistProviderInstance(
      { operation: "upsert", instanceId: row.instanceId, instance: next },
      patch,
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  const deleteProviderInstance = async (row: InstanceRow) => {
    const updateResult = await persistProviderInstance({
      operation: "remove",
      instanceId: row.instanceId,
    });
    if (updateResult._tag === "Failure") {
      const error = squashAtomCommandFailure(updateResult);
      toastManager.add({
        type: "error",
        title: "Could not delete provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
  };

  const resetDefaultInstance = async (driverKind: ProviderDriverKind) => {
    const result = await persistProviderInstance({
      operation: "remove",
      instanceId: defaultInstanceIdForDriver(driverKind),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not reset provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const driverOption = providerClients.get(row.driver);
    const liveProvider = serverProviders.find(
      (candidate) => candidate.instanceId === row.instanceId,
    );
    const updateCandidate = providerUpdateCandidateByInstanceId.get(row.instanceId);
    const isInstanceUpdateRunning =
      updatingProviderInstanceIds.has(row.instanceId) ||
      (liveProvider !== undefined && isProviderUpdateActive(liveProvider));
    const showInlineUpdateButton = updateCandidate !== undefined;
    const canRunInlineUpdate = updateCandidate !== undefined && !isInstanceUpdateRunning;
    const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const resetLabel = driverOption?.label ?? String(row.driver);
    return (
      <ProviderInstanceCard
        key={row.instanceId}
        environmentId={environmentId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={driverOption}
        liveProvider={liveProvider}
        markColor={markColorByInstanceId.get(row.instanceId)}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        onSelect={mode === "list" ? () => setSelectedInstanceId(row.instanceId) : undefined}
        readOnly={readOnly}
        runtime={
          mode === "editor" &&
          row.driver === "codex" &&
          readCodexSetupMode(row.instance.config) === "managed" ? (
            <CodexManagedRuntimeFields
              environmentId={environmentId}
              instanceId={row.instanceId}
              provider={liveProvider}
            />
          ) : undefined
        }
        canWriteSettings={canWriteSettings}
        setup={
          <>
            {mode === "editor" &&
            row.driver === "codex" &&
            readCodexSetupMode(row.instance.config) === "managed" ? (
              <CodexSetupSection
                environmentId={environmentId}
                instanceId={row.instanceId}
                provider={liveProvider}
                mode={readCodexSetupMode(row.instance.config)}
                enabled={resolveProviderInstanceEnabled(row.instance)}
                readOnly={readOnly}
                onModeChange={(setupMode) =>
                  updateProviderInstance(row, {
                    ...row.instance,
                    enabled: true,
                    config: {
                      ...(row.instance.config !== null && typeof row.instance.config === "object"
                        ? row.instance.config
                        : {}),
                      enabled: true,
                      setupMode,
                    },
                  })
                }
              />
            ) : mode === "editor" &&
              !readOnly &&
              liveProvider &&
              liveProvider.setup?.canAuthenticate ? (
              <>
                <ProviderAuthenticationSection
                  key={`${environmentId}:${row.instanceId}`}
                  environmentId={environmentId}
                  environmentLabel={environmentLabel}
                  instanceId={row.instanceId}
                  provider={liveProvider}
                  readOnly={readOnly}
                />
              </>
            ) : null}
            {mode === "editor" && liveProvider ? (
              <ProviderMachineSignIns
                environmentId={environmentId}
                instanceId={row.instanceId}
                provider={liveProvider}
                readOnly={readOnly}
              />
            ) : null}
          </>
        }
        onUpdate={(next) => {
          const wasEnabled = resolveProviderInstanceEnabled(row.instance);
          const isDisabling = next.enabled === false && wasEnabled;
          const shouldClearTextGen =
            isDisabling &&
            textGenInstanceId === row.instanceId &&
            readEnvironmentScope(environmentId, AuthSettingsWriteScope);
          updateProviderInstance(
            row,
            next,
            shouldClearTextGen
              ? {
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                }
              : undefined,
          );
        }}
        onDelete={
          mode === "editor" && !row.isDefault ? () => deleteProviderInstance(row) : undefined
        }
        headerAction={
          mode === "editor" && row.isDefault && row.isDirty ? (
            <SettingResetButton
              label={`${resetLabel} provider settings`}
              onClick={() => resetDefaultInstance(row.driver)}
            />
          ) : null
        }
        hiddenModels={modelPreferences.hiddenModels}
        modelOrder={modelPreferences.modelOrder}
        onHiddenModelsChange={(next, affectedModels) => {
          const hidden = new Set(next);
          const models = affectedModels ?? modelListChanges(modelPreferences.hiddenModels, next);
          void updateModelPreferences({
            setModelsHidden: models.map((model) => ({
              provider: row.instanceId,
              model,
              hidden: hidden.has(model),
            })),
          });
        }}
        onModelOrderChange={(modelOrder) => {
          void updateModelPreferences({
            setProviderModelOrder: { provider: row.instanceId, modelOrder },
          });
        }}
        effortDefaults={settings.modelEffortDefaults?.[row.instanceId]}
        onEffortDefaultChange={(model, option) => {
          void updateModelPreferences({
            setModelEffortDefault: { provider: row.instanceId, model, option },
          });
        }}
        onInstallRecommended={
          !readOnly &&
          liveProvider?.compatibilityAdvisory?.message &&
          liveProvider.compatibilityAdvisory.recommendedVersion &&
          liveProvider.versionAdvisory?.canInstallVersion
            ? () => {
                void runProviderUpdate(
                  liveProvider,
                  liveProvider.compatibilityAdvisory?.recommendedVersion ?? undefined,
                );
              }
            : undefined
        }
        onRunUpdate={
          !readOnly && showInlineUpdateButton && updateCandidate
            ? () => {
                if (canRunInlineUpdate) void runProviderUpdate(updateCandidate);
              }
            : undefined
        }
        isUpdating={isInstanceUpdateRunning}
      />
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("providers")}
        variant="plain"
        headerAction={
          <>
            <ProviderUpdatesAction />
            <SettingsRefreshAction
              label="Refresh provider status"
              refreshing={isRefreshingProviders}
              disabled={!canRefreshProviders}
              checkedAt={lastCheckedAt}
              onRefresh={() => void refreshProviders()}
            />
          </>
        }
      >
        {machineTabs ? (
          <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 sm:px-4">{machineTabs}</div>
        ) : null}
        {readOnly ? (
          <SettingsGroup divided={false} className="overflow-hidden">
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s providers but can't change their settings.`}
            />
          </SettingsGroup>
        ) : null}
        <SettingsMasterDetail
          size="page"
          list={
            <>
              {rows.map((row) => renderProviderInstance(row, "list"))}
              {!readOnly ? (
                <SettingsMasterDetailAddRow onClick={() => setIsAddInstanceDialogOpen(true)}>
                  Add provider
                </SettingsMasterDetailAddRow>
              ) : null}
            </>
          }
          detail={
            selectedRow ? (
              <SettingsMasterDetailEditor>
                {renderProviderInstance(selectedRow, "editor")}
              </SettingsMasterDetailEditor>
            ) : (
              <Empty size="sm">
                <EmptyHeader>
                  <EmptyTitle>
                    {targetInstanceMissing ? "Provider not found" : "No providers yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {targetInstanceMissing
                      ? `This provider is no longer set up on ${environmentLabel}. Pick another one from the list.`
                      : "Add Codex, Claude or another agent CLI so threads can run on this machine."}
                  </EmptyDescription>
                </EmptyHeader>
                {readOnly ? null : (
                  <EmptyContent>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsAddInstanceDialogOpen(true)}
                    >
                      <PlusIcon />
                      Add provider
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow
          {...searchableSetting("provider-health-check-interval")}
          description="How often to check each provider's sign-in, version and models. 0 turns checks off. Background activity in General can pause them to save power."
          resetAction={
            providerHealthRefreshIntervalSeconds !== defaultProviderHealthRefreshIntervalSeconds ? (
              <span
                inert={!canWriteSettings}
                className={!canWriteSettings ? "opacity-50" : undefined}
              >
                <SettingResetButton
                  label="provider health check interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: undefined },
                      ),
                    )
                  }
                />
              </span>
            ) : null
          }
          control={
            <div
              inert={!canWriteSettings}
              aria-disabled={!canWriteSettings || undefined}
              className={cn(
                "flex shrink-0 items-center gap-2",
                !canWriteSettings && "opacity-50 select-none",
              )}
            >
              <SettingsNumberField
                label="provider health check interval"
                unit="seconds"
                value={providerHealthRefreshIntervalSeconds}
                min={0}
                step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                onValueChange={(value) =>
                  updateSettings(
                    backgroundActivityOverrideSettings(
                      settings.backgroundActivity,
                      resolvedBackgroundActivity,
                      {
                        providerHealthRefreshInterval: Duration.seconds(
                          normalizeIntervalSeconds(value),
                        ),
                      },
                    ),
                  )
                }
              />
            </div>
          }
        />
      </SettingsSection>

      <OverlayPresence when={isAddInstanceDialogOpen && !readOnly}>
        {() => (
          <AddProviderInstanceDialog
            open
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            onOpenChange={setIsAddInstanceDialogOpen}
            onCreated={setSelectedInstanceId}
          />
        )}
      </OverlayPresence>
    </>
  );
}

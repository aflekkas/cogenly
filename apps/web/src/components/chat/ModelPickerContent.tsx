import {
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { Combobox, ComboboxEmpty, ComboboxItem, ComboboxListVirtualized } from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  return input.options.find((option) => option.slug === input.model);
}

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  return isProviderInstancePickerReady(input.entry);
}

export function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

export function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId;
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}) {
  const providers = input.entries
    .filter(
      (entry) =>
        !input.disabledInstanceIds?.has(entry.instanceId) &&
        (isProviderInstancePickerReady(entry) ||
          input.selectableUnavailableInstanceIds?.has(entry.instanceId)),
    )
    .map((entry) => entry.instanceId);
  if (providers.length === 0) {
    return input.selectedInstanceId;
  }
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

type ModelListResize = {
  /** Room the list may take inside the popover, so growth ends where it visibly stops. */
  readonly maxHeight: number;
  /** Rows height to shrink to while collapsing; the legacy rows stay mounted until then. */
  readonly collapsedHeight?: number;
};

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Room the list frame may take inside the popover, in pixels. */
function measureModelListMaxHeight(frame: HTMLElement): number | null {
  const picker = frame.closest<HTMLElement>("[data-model-picker-content]");
  if (!picker) return null;
  const pickerMaxHeight = Number.parseFloat(getComputedStyle(picker).maxHeight);
  // The popover viewport is capped to the space beside the trigger and also
  // holds content below the picker.
  const viewport = picker.closest<HTMLElement>("[data-slot=popover-viewport]");
  const viewportMaxHeight = viewport
    ? Number.parseFloat(getComputedStyle(viewport).maxHeight)
    : Number.NaN;
  const pickerRoom = Number.isFinite(viewportMaxHeight)
    ? Math.min(pickerMaxHeight, viewportMaxHeight - (viewport!.scrollHeight - picker.offsetHeight))
    : pickerMaxHeight;
  if (!Number.isFinite(pickerRoom)) return null;
  return pickerRoom - (picker.offsetHeight - frame.offsetHeight);
}

/**
 * Measure the list frame before Legacy models opens or closes. The frame's
 * height then transitions between the two content heights, and the popover
 * follows it, so the popover resizes in one transition instead of jumping.
 */
function measureLegacyResize(input: {
  frame: HTMLElement;
  listState: ReturnType<LegendListRef["getState"]> | undefined;
  legacyKey: string;
  collapsing: boolean;
}): ModelListResize | null {
  const maxHeight = measureModelListMaxHeight(input.frame);
  if (maxHeight === null) return null;
  if (!input.collapsing) return { maxHeight };
  // The row's own height: the list's measured size for it includes the separator after it.
  const legacyTop = input.listState?.positionByKey(input.legacyKey);
  const legacyRow = input.frame.querySelector<HTMLElement>("[data-model-picker-legacy-row]");
  if (legacyTop === undefined || !legacyRow) return null;
  return { maxHeight, collapsedHeight: legacyTop + legacyRow.offsetHeight };
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 52;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
  } = props;
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const modelListElementRef = useRef<HTMLDivElement>(null);
  const modelListFrameRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug = activeModel?.slug ?? props.model;
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = useMemo(
    () =>
      props.selectedModels?.map((selection) => {
        const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
        const model = resolveModelPickerSelectedModel({
          driverKind: entry?.driverKind,
          model: selection.model,
          options: modelOptionsByInstance.get(selection.instanceId) ?? [],
        });
        return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
      }),
    [instanceEntries, modelOptionsByInstance, props.selectedModels],
  );
  const selectedModelKeySet = useMemo(
    () => new Set(selectedModelKeys ?? (activeModelKey ? [activeModelKey] : [])),
    [selectedModelKeys, activeModelKey],
  );
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  // The picker always opens on the current model's provider.
  const [selectedInstanceId, setSelectedInstanceId] = useState(props.activeInstanceId);
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.some((model) => model.slug === activeModelSlug && model.isLegacy)
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const [modelListResize, setModelListResize] = useState<ModelListResize | null>(null);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const navigate = useNavigate();
  // The listbox owns keyboard navigation (arrows, Enter) and announces the
  // highlighted row through aria-activedescendant, so it is the focus target.
  const focusModelList = useCallback(() => {
    modelListElementRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: ProviderInstanceId) => {
      // Measure before the switch so the frame transitions from the old
      // provider's list height to the new one instead of jumping.
      const frame = modelListFrameRef.current;
      const maxHeight =
        frame && instanceId !== selectedInstanceId && !prefersReducedMotion()
          ? measureModelListMaxHeight(frame)
          : null;
      setModelListResize(maxHeight === null ? null : { maxHeight });
      setSelectedInstanceId(instanceId);
      window.requestAnimationFrame(() => {
        focusModelList();
      });
    },
    [focusModelList, selectedInstanceId],
  );

  // A resize whose height does not change never fires transitionend; clear
  // the cap shortly after the transition would have ended either way.
  useEffect(() => {
    if (!modelListResize) return;
    const timer = window.setTimeout(() => setModelListResize(null), 300);
    return () => window.clearTimeout(timer);
  }, [modelListResize]);

  useLayoutEffect(() => {
    focusModelList();
    // The popup mounts its content before it finishes opening; retry once it settles.
    const frame = window.requestAnimationFrame(() => {
      focusModelList();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusModelList]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  }, [
    activeInstanceHasSelectableUnavailableModel,
    instanceEntries,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.onOpenProviderSetup,
  ]);

  // Flatten models into one array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, props.activeInstanceId, activeModelSlug]);

  const isLocked = props.lockedProvider !== null;
  const lockedDisabledInstanceIds = useMemo(() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const showSidebar = sidebarInstanceEntries.length > 0;

  const filteredModels = useMemo(
    () =>
      flatModels.filter(
        (model) => model.instanceId === selectedInstanceId && matchesLockedProvider(model),
      ),
    [flatModels, matchesLockedProvider, selectedInstanceId],
  );

  const legacySection = useMemo(() => {
    const currentModels = filteredModels.filter((model) => !model.isLegacy);
    const legacyModels = filteredModels.filter((model) => model.isLegacy);
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
      // Collapsing keeps the rows until the list has shrunk over them.
      rendersLegacyModels:
        expandedLegacyInstances.has(selectedInstanceId) ||
        modelListResize?.collapsedHeight !== undefined,
    };
  }, [expandedLegacyInstances, filteredModels, modelListResize, selectedInstanceId]);

  const visibleModels = useMemo(() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.rendersLegacyModels ? legacySection.legacyModels : []),
    ];
  }, [filteredModels, legacySection]);

  const selectedEntry = entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    props.onOpenProviderSetup &&
    selectedEntry &&
    matchesLockedProvider(selectedEntry) &&
    shouldOfferModelPickerSetup(
      selectedEntry,
      modelOptionsByInstance.get(selectedEntry.instanceId) ?? [],
    )
      ? [selectedEntry]
      : [];

  // Models the manifest announces that this provider's installed CLI is too
  // old to run. Without this, a new model just seems missing until the user
  // happens to update the CLI.
  const updateRequiredNotice = selectedEntry
    ? formatProviderUpdateRequiredNotice(selectedEntry.snapshot)
    : null;

  const toggleLegacySection = useCallback(
    (instanceId: ProviderInstanceId) => {
      const isExpanded = expandedLegacyInstances.has(instanceId);
      const frame = modelListFrameRef.current;
      const resize =
        frame && !prefersReducedMotion()
          ? measureLegacyResize({
              frame,
              listState: modelListRef.current?.getState(),
              legacyKey: modelPickerLegacySectionKey(instanceId),
              collapsing: isExpanded,
            })
          : null;
      setModelListResize(resize);
      setExpandedLegacyInstances((expanded) => {
        const next = new Set(expanded);
        if (isExpanded) {
          next.delete(instanceId);
        } else {
          next.add(instanceId);
        }
        return next;
      });
    },
    [expandedLegacyInstances],
  );

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId, additive = false) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        if (additive && onToggleModel) {
          onToggleModel(instanceId, resolvedModel);
        } else {
          onInstanceModelChange(instanceId, resolvedModel);
        }
      }
    },
    [
      entryByInstanceId,
      getModelDisabledReason,
      modelOptionsByInstance,
      onInstanceModelChange,
      onToggleModel,
    ],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allItemKeys = useMemo(
    (): string[] => [
      ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
      ...new Set(
        flatModels
          .filter((model) => model.isLegacy)
          .map((model) => modelPickerLegacySectionKey(model.instanceId)),
      ),
    ],
    [flatModels],
  );
  const filteredItemKeys = useMemo((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  }, [legacySection, visibleModels]);
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  const [modelListContentSize, setModelListContentSize] = useState(
    () => filteredItemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
  );
  useLayoutEffect(
    () => modelListRef.current?.getState().listen("totalSize", setModelListContentSize),
    [],
  );
  // Fit the list to its rows plus the combobox list `py-1` and LegendList `py-1.5`.
  // While Legacy models opens or closes, the height is capped to the room the
  // popover has, so the transition ends where the list visibly stops growing.
  const modelListContentHeight = `calc(${modelListResize?.collapsedHeight ?? modelListContentSize}px + var(--spacing) * 5)`;
  const modelListHeight =
    filteredItemKeys.length === 0
      ? 0
      : modelListResize
        ? `min(${modelListContentHeight}, ${modelListResize.maxHeight}px)`
        : modelListContentHeight;
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        modelPickerOpen: true,
      }) as const,
    [],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
  const modelListExtraData = useMemo(
    () => ({ modelJumpLabelByKey, activeModelKey, selectedModelKeySet }),
    [modelJumpLabelByKey, activeModelKey, selectedModelKeySet],
  );

  const handleModelListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      showSidebar &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      ((event.key === "ArrowLeft" && !event.shiftKey) || (event.key === "Tab" && event.shiftKey))
    ) {
      const sidebar = event.currentTarget
        .closest("[data-model-picker-content]")
        ?.querySelector("[data-model-picker-sidebar]");
      const button =
        sidebar?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)') ??
        sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        button.focus();
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onRequestClose?.();
      return;
    }
    if (event.key === "Enter" && highlightedModelKeyRef.current) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      const legacyInstanceId = parseModelPickerLegacySectionKey(highlightedModelKeyRef.current);
      if (legacyInstanceId) {
        toggleLegacySection(legacyInstanceId);
        return;
      }
      const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
      if (model) {
        handleModelSelect(model.slug, model.instanceId, event.shiftKey);
      }
      return;
    }
    // Keep list keys away from the composer underneath.
    event.stopPropagation();
  };

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        const next = adjacentModelPickerProvider({
          entries: sidebarInstanceEntries,
          selectedInstanceId,
          direction: command === "modelPicker.nextProvider" ? 1 : -1,
          disabledInstanceIds: lockedDisabledInstanceIds,
          selectableUnavailableInstanceIds,
        });
        handleSelectInstance(next);
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const model = parseModelPickerModelKey(targetModelKey);
      if (!model) {
        return;
      }
      handleModelSelect(model.slug, model.instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    handleModelSelect,
    handleSelectInstance,
    keybindings,
    lockedDisabledInstanceIds,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    selectableUnavailableInstanceIds,
    selectedInstanceId,
    sidebarInstanceEntries,
  ]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  return (
    <TooltipProvider delay={0}>
      <div
        ref={pickerContentRef}
        className="relative flex max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
        data-model-picker-content="true"
      >
        {/* Sidebar */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusList={focusModelList}
            instanceEntries={sidebarInstanceEntries}
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
                }
              : {})}
          />
        )}

        {/* Main content area */}
        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          // No query input: keep the query empty so the selected value's label
          // never stands in for one and bypasses `filteredItems`.
          inputValue=""
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            {/* Model list */}
            <div
              ref={modelListFrameRef}
              className={cn(
                "relative min-h-0 overflow-hidden pr-px",
                modelListResize &&
                  "transition-[height] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
              )}
              style={{ height: modelListHeight }}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && event.propertyName === "height") {
                  setModelListResize(null);
                }
              }}
            >
              <ComboboxListVirtualized ref={modelListElementRef} onKeyDown={handleModelListKeyDown}>
                <LegendList<string>
                  ref={modelListRef}
                  data={filteredItemKeys}
                  extraData={modelListExtraData}
                  keyExtractor={(modelKey) => modelKey}
                  renderItem={({ item: modelKey, index }) => {
                    if (legacySection?.key === modelKey) {
                      return (
                        <ComboboxItem
                          hideIndicator
                          index={index}
                          value={modelKey}
                          aria-expanded={legacySection.isExpanded}
                          data-model-picker-legacy-row=""
                          className="group w-full cursor-pointer"
                        >
                          <div className="min-w-0 flex-1 text-left">
                            <div className="text-xs font-medium leading-snug">Legacy models</div>
                            <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                              {legacySection.legacyModels.length} models
                            </div>
                          </div>
                          <ChevronRightIcon
                            className={cn(
                              "size-4 transition-transform",
                              legacySection.isExpanded && "rotate-90",
                            )}
                          />
                        </ComboboxItem>
                      );
                    }
                    const model = filteredModelByKey.get(modelKey);
                    if (!model) {
                      return null;
                    }
                    const disabledReason =
                      getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                    return (
                      <ModelListRow
                        key={modelKey}
                        index={index}
                        model={model}
                        instanceId={model.instanceId}
                        driverKind={model.driverKind}
                        providerDisplayName={model.instanceDisplayName}
                        providerAccentColor={model.instanceAccentColor}
                        isSelected={
                          selectedModelKeys !== undefined
                            ? selectedModelKeySet.has(modelKey)
                            : modelKey === activeModelKey
                        }
                        showSelection={selectedModelKeys !== undefined}
                        showProvider
                        preferShortName={!isLocked}
                        useTriggerLabel={false}
                        showNewBadge={model.badge === "new"}
                        unavailable={model.isUnavailable === true}
                        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                        disabledReason={disabledReason}
                      />
                    );
                  }}
                  estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
                  drawDistance={480}
                  recycleItems
                  contentContainerClassName="pl-2 pr-px"
                  ItemSeparatorComponent={ModelListSeparator}
                  onLayout={updateModelListScrollFades}
                  onScroll={updateModelListScrollFades}
                  className={cn(
                    "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                    getVirtualizedScrollFadeClassName({
                      top: showTopScrollFade,
                      bottom: showBottomScrollFade,
                    }),
                  )}
                />
              </ComboboxListVirtualized>
            </div>
            {providerSetupEntries.length > 0 ? (
              <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
                {providerSetupEntries.map((entry) => (
                  <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                    <p className="line-clamp-3 text-muted-foreground">
                      {getProviderStatusMessage(entry.snapshot)}
                    </p>
                    <InlineButton
                      className="mt-1"
                      onClick={() => {
                        props.onRequestClose?.();
                        props.onOpenProviderSetup?.(entry.instanceId);
                      }}
                    >
                      {providerSetupEntries.length > 1
                        ? `Set up ${entry.displayName}`
                        : "Open provider setup"}
                    </InlineButton>
                  </div>
                ))}
              </div>
            ) : (
              <ComboboxEmpty className="empty:h-0">No models found</ComboboxEmpty>
            )}
            {updateRequiredNotice ? (
              <p className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground">
                {updateRequiredNotice}{" "}
                <InlineButton
                  onClick={() => {
                    props.onRequestClose?.();
                    void navigate({ to: "/settings/providers" });
                  }}
                >
                  Provider settings
                </InlineButton>
              </p>
            ) : null}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});

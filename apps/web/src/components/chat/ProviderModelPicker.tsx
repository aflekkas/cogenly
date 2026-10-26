import {
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@cogenly/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ChatGptSharingControl } from "./ChatGptSharingControl";
import { ProviderIconStack } from "./ProviderIconStack";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import {
  ComposerControl,
  ComposerControlChevron,
  composerControlGapClassName,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";

/**
 * The trigger's label and chevron frames. A narrow composer collapses them with
 * grid-cols-[0fr], opacity-0 and a negative start margin that takes back the gap;
 * all three ease together. Reduced motion keeps the fade and snaps the width.
 */
const COLLAPSIBLE_FRAME_CLASS =
  "grid min-w-0 grid-cols-[1fr] transition-[grid-template-columns,opacity,margin-inline-start] duration-(--motion-duration-base) ease-out motion-reduce:transition-opacity";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  environmentId: EnvironmentId | null;
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  instanceIndicatorBackground?: string;
  size?: ComposerControlSize;
  compact?: boolean;
  isComposerOwned?: boolean;
  disabled?: boolean;
  open?: boolean;
  triggerClassName?: string;
  /** Aggregate settings can show a neutral value without claiming one provider is selected. */
  triggerLabel?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const size = props.size ?? "sm";

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // Account-specific catalogs must keep the selected model label while unavailable.
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: props.model,
      options: selectedInstanceOptions,
    }) ?? selectedInstanceOptions[0];
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel)
    : props.model || "Choose model";
  const triggerLabel = selectedModel
    ? `${getTriggerDisplayModelLabel(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : triggerTitle;
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const selectedEntries = props.selectedModels?.map((selection) => {
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: props.modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return {
      ...selection,
      entry,
      label: model
        ? `${getTriggerDisplayModelName(model)}${model.isUnavailable ? " (Unavailable)" : ""}`
        : selection.model,
    };
  });
  const multipleLabel = selectedEntries
    ? selectedEntries.length === 0
      ? "Choose models"
      : `${selectedEntries
          .slice(0, 2)
          .map((selection) => selection.label)
          .join(", ")}${selectedEntries.length > 2 ? `, ${selectedEntries.length - 2} more` : ""}`
    : undefined;
  const allModelNames = selectedEntries
    ? selectedEntries.map((selection) => selection.label).join(", ") || "Choose models"
    : undefined;
  // A provider with several instances names the one in use, as the glyph's dot only colors it.
  const triggerModelLabel =
    props.triggerLabel ??
    allModelNames ??
    (showInstanceBadge && activeEntry
      ? `${triggerLabel} · ${activeEntry.displayName}`
      : triggerLabel);
  const triggerTooltipContent = shortcutLabel
    ? `${triggerModelLabel} · ${shortcutLabel}`
    : triggerModelLabel;
  const selectedStackItems = selectedEntries
    ? [
        ...selectedEntries.slice(0, 3).flatMap((selection) =>
          selection.entry
            ? [
                {
                  key: `${selection.instanceId}:${selection.model}`,
                  icon: (
                    <ProviderInstanceIcon
                      driverKind={selection.entry.driverKind}
                      displayName={selection.entry.displayName}
                      accentColor={selection.entry.accentColor}
                      showBadge={shouldShowInstanceBadge(selection.entry, props.instanceEntries)}
                      indicatorBackground="var(--provider-stack-ring)"
                      iconClassName="size-4"
                    />
                  ),
                },
              ]
            : [],
        ),
        ...(selectedEntries.length > 3
          ? [
              {
                key: "overflow",
                icon: <span className="text-3xs leading-none">+{selectedEntries.length - 3}</span>,
              },
            ]
          : []),
      ]
    : [];

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={props.triggerAriaLabel ?? allModelNames ?? triggerModelLabel}
            size={size}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 shrink justify-between whitespace-nowrap",
              props.compact
                ? "max-w-42 shrink-0"
                : !props.isComposerOwned && "max-w-48 sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center",
                  composerControlGapClassName(size),
                )}
              />
            }
          >
            {selectedEntries && props.triggerLabel === undefined ? (
              <ProviderIconStack
                className="[--provider-stack-ring:var(--chat-composer-glass-surface,var(--background))]"
                items={selectedStackItems}
              />
            ) : activeEntry && props.triggerLabel === undefined ? (
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                showBadge={showInstanceBadge}
                // Brand marks fill their box; the margin gives them the side bearing the
                // lucide icons on the other controls have, so the gaps match.
                className="mx-px size-4"
                iconClassName={cn("size-4", props.activeProviderIconClassName)}
                indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
              />
            ) : null}
            {/* A one-column grid so a container can collapse the label to icon-only
              (grid-cols-[0fr]) and the width eases instead of snapping. */}
            <span
              className={COLLAPSIBLE_FRAME_CLASS}
              data-chat-provider-model-picker-label-frame="true"
            >
              <span
                // flex-1 is inert in the grid; measurement reads flex-none as the
                // resting strip's deliberate collapse.
                className="min-w-0 flex-1 overflow-hidden truncate"
                data-chat-provider-model-picker-label="true"
              >
                {props.triggerLabel ?? multipleLabel ?? triggerTitle}
              </span>
            </span>
            {selectedModel?.isUnavailable &&
            !selectedEntries &&
            props.triggerLabel === undefined ? (
              <Badge variant="outline" size="sm">
                Unavailable
              </Badge>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
        </Tooltip>
        {/* The chevron's optical margins sit on the frame, outside its clip, so they
          match the other controls' chevrons without cutting off the glyph. */}
        <span
          aria-hidden="true"
          className={cn(COLLAPSIBLE_FRAME_CLASS, size === "xs" ? "-ms-0.5 -me-1" : "-mx-0.5")}
          data-chat-provider-model-picker-chevron="true"
        >
          <span className="flex min-w-0 items-center overflow-hidden">
            <ComposerControlChevron size={size} className="m-0!" />
          </span>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        align="start"
        // The picker holds its size while its lists filter and swap.
        animateHeight={false}
        className="before:hidden"
        padding="none"
      >
        <ModelPickerContent
          environmentId={props.environmentId}
          activeInstanceId={activeInstanceId}
          model={props.model}
          {...(props.selectedModels !== undefined ? { selectedModels: props.selectedModels } : {})}
          {...(props.onToggleModel
            ? {
                onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                  if (!props.disabled) props.onToggleModel?.(instanceId, model);
                },
              }
            : {})}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
          {...(props.getModelDisabledReason
            ? { getModelDisabledReason: props.getModelDisabledReason }
            : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
        {props.selectedModels === undefined ? (
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});

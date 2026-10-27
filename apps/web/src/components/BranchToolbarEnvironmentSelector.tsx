import { ComposerSelectControl } from "./chat/ComposerControl";
import { COMPOSER_CONTEXT_TOOLTIP, ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@cogenly/contracts";
import { ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { type EnvironmentOption, resolveEnvironmentOptionTitle } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

/**
 * One "Run on" choice, as both the Select and the run-context menu list it.
 * A paired machine that is offline stays pickable; the launch then offers to
 * run here instead.
 */
export function EnvironmentOptionContent({ option }: { option: EnvironmentOption }) {
  const offline = option.pairedMachine?.online === false;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <EnvironmentMachineIcon
        kind={option.machine}
        className={offline ? "size-3 shrink-0 opacity-50" : "size-3 shrink-0"}
      />
      <span className="min-w-0 truncate">{option.label}</span>
      {offline ? <span className="shrink-0 text-muted-foreground">offline</span> : null}
    </span>
  );
}

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    ],
    [availableEnvironments, autoEnvironmentLabel, onAutoEnvironment],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground text-xs sm:h-6"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup {...COMPOSER_CONTEXT_TOOLTIP}>
          {activeEnvironment ? resolveEnvironmentOptionTitle(activeEnvironment) : "Run on"}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? "auto" : environmentId}
      onValueChange={(value) =>
        value === "auto" ? onAutoEnvironment?.() : onEnvironmentChange(value as EnvironmentId)
      }
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup {...COMPOSER_CONTEXT_TOOLTIP}>
          {autoEnvironmentLabel ??
            (activeEnvironment ? resolveEnvironmentOptionTitle(activeEnvironment) : "Run on")}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value="auto"
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <EnvironmentOptionContent option={env} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

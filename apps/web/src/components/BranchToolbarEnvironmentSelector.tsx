import { ComposerSelectControl } from "./chat/ComposerControl";
import {
  COMPOSER_CONTEXT_TOOLTIP,
  ComposerContextLabel,
  ComposerContextStatic,
} from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@cogenly/contracts";
import { ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import {
  type EnvironmentOption,
  environmentOptionMachine,
  resolveEnvironmentOptionName,
  resolveEnvironmentOptionTitle,
} from "./BranchToolbar.logic";
import { MachineChoice, MachineGlyph } from "./MachineBadge";
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
 * One "Run on" choice, as both the Select and the run-context menu list it:
 * "This computer", or another machine's name with a cloud. A paired machine
 * that is offline stays pickable; the launch then offers to run here instead.
 */
export function EnvironmentOptionContent({ option }: { option: EnvironmentOption }) {
  const localEnvironmentId = usePrimaryEnvironmentId();
  return <MachineChoice machine={environmentOptionMachine(option, localEnvironmentId)} />;
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
  const localEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);
  const activeMachine =
    activeEnvironment === null
      ? null
      : environmentOptionMachine(activeEnvironment, localEnvironmentId);
  const activeTitle = activeEnvironment
    ? resolveEnvironmentOptionTitle(activeEnvironment, localEnvironmentId)
    : "Run on";

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: resolveEnvironmentOptionName(env, localEnvironmentId),
      })),
    ],
    [availableEnvironments, autoEnvironmentLabel, onAutoEnvironment, localEnvironmentId],
  );

  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = (
      <ComposerContextStatic>
        <MachineGlyph machine={activeMachine} className="size-3" />
        <ComposerContextLabel>
          {activeEnvironment === null
            ? "Run on"
            : resolveEnvironmentOptionName(activeEnvironment, localEnvironmentId)}
        </ComposerContextLabel>
      </ComposerContextStatic>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup {...COMPOSER_CONTEXT_TOOLTIP}>{activeTitle}</TooltipPopup>
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
            <MachineGlyph machine={activeMachine} className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup {...COMPOSER_CONTEXT_TOOLTIP}>
          {autoEnvironmentLabel ?? activeTitle}
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

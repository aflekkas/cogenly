import type { RuntimeMode } from "@t3tools/contracts";
import { memo } from "react";

import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

const ALL_RUNTIME_MODES = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider offers; a provider that lists none offers every mode. */
export function availableRuntimeModes(
  supported: ReadonlyArray<RuntimeMode> | undefined,
): ReadonlyArray<RuntimeMode> {
  return supported === undefined || supported.length === 0
    ? ALL_RUNTIME_MODES
    : ALL_RUNTIME_MODES.filter((mode) => supported.includes(mode));
}

/** Radio items for the access modes, shared by the picker and the overflow menu. */
export function ComposerAccessModeMenuContent(props: {
  runtimeMode: RuntimeMode;
  runtimeModes: ReadonlyArray<RuntimeMode>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <>
      <MenuGroupLabel>Access</MenuGroupLabel>
      <MenuRadioGroup
        value={props.runtimeMode}
        onValueChange={(value: RuntimeMode) => {
          if (value !== props.runtimeMode) props.onRuntimeModeChange(value);
        }}
      >
        {props.runtimeModes.map((mode) => {
          const config = runtimeModeConfig[mode];
          return (
            <MenuRadioItem key={mode} value={mode}>
              <span className="flex items-start gap-2">
                <config.icon aria-hidden="true" className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{config.label}</span>
                  <span className="text-muted-foreground text-xs">{config.description}</span>
                </span>
                <MenuRadioItemIndicator className="mt-0.5" />
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
    </>
  );
}

/** The composer's per-thread access picker ("Full access", "Supervised", ...). */
export const ComposerAccessModePicker = memo(function ComposerAccessModePicker(props: {
  runtimeMode: RuntimeMode;
  runtimeModes: ReadonlyArray<RuntimeMode>;
  size?: "sm" | "xs";
  hidden?: boolean;
  disabled?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden || props.disabled);
  const config = runtimeModeConfig[props.runtimeMode];

  return (
    <Menu open={open} onOpenChange={(next) => setOpen(next && !props.disabled)}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            disabled={props.disabled}
            className="shrink-0 whitespace-nowrap"
            aria-label={`Access: ${config.label}`}
            data-composer-access-mode={props.runtimeMode}
          />
        }
      >
        <ComposerControlIcon icon={config.icon} size={size} />
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          {config.label}
        </span>
        <ComposerControlChevron size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <ComposerAccessModeMenuContent
          runtimeMode={props.runtimeMode}
          runtimeModes={props.runtimeModes}
          onRuntimeModeChange={(mode) => {
            setOpen(false);
            props.onRuntimeModeChange(mode);
          }}
        />
      </MenuPopup>
    </Menu>
  );
});

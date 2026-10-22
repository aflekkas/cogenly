import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ProjectIconColor } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { normalizeProjectColor, PROJECT_ICON_COLORS } from "../projectIconColors";

type ColorOption = (typeof PROJECT_ICON_COLORS)[number];

const optionByValue = new Map(PROJECT_ICON_COLORS.map((option) => [option.value, option]));

function Swatch(props: { readonly option: ColorOption }) {
  const { option } = props;
  return (
    <RadioPrimitive.Root
      value={option.value}
      aria-label={option.label}
      className="group/swatch relative size-7 shrink-0 cursor-pointer rounded-full outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring data-disabled:cursor-not-allowed data-disabled:opacity-50"
      style={{ "--swatch": `var(--color-${option.value}-500)` } as CSSProperties}
    >
      <span
        aria-hidden
        className="absolute inset-1 rounded-full bg-(--swatch) transition-transform duration-(--motion-duration-fast) ease-standard group-hover/swatch:scale-110 group-data-checked/swatch:scale-100 motion-reduce:transition-none"
      />
      {/* Selected: a gap in the surface color leaves an outer rim in the swatch's own color around a checked core. */}
      <RadioPrimitive.Indicator
        keepMounted
        aria-hidden
        className="absolute inset-1.5 rounded-full bg-popover transition-transform duration-(--motion-duration-fast) ease-standard data-unchecked:scale-0 motion-reduce:transition-none"
      >
        <span className="absolute inset-0.5 flex items-center justify-center rounded-full bg-(--swatch) text-white">
          <CheckIcon className="size-2.5" strokeWidth={3.5} />
        </span>
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

/**
 * A project's color as one row of swatches, the whole palette. A retired hue
 * shows as its nearest remaining one. Arrow keys move between swatches;
 * Enter or Space picks one.
 */
export function ProjectColorPicker(props: {
  readonly value: string | undefined;
  readonly onChange: (value: ProjectIconColor) => void;
  /** Accessible name of the group, such as "Project color". */
  readonly label: string;
  readonly labelledBy?: string;
  readonly disabled?: boolean;
}) {
  const { onChange } = props;
  const normalized = normalizeProjectColor(props.value);
  const current = normalized === null ? undefined : optionByValue.get(normalized);

  return (
    <RadioGroupPrimitive
      value={current?.value ?? null}
      disabled={props.disabled}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") onChange(next as ProjectIconColor);
      }}
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      className="-mx-1 flex flex-wrap items-center gap-0.5"
    >
      {PROJECT_ICON_COLORS.map((option) => (
        <Swatch key={option.value} option={option} />
      ))}
    </RadioGroupPrimitive>
  );
}

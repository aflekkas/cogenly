import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ProjectIconColor } from "@t3tools/contracts";
import { CheckIcon, EllipsisIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { cn } from "../lib/utils";
import { PROJECT_ICON_COLORS } from "../projectIconColors";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";

type ColorOption = (typeof PROJECT_ICON_COLORS)[number];

/** The row: one of each hue family, so near-duplicates (indigo beside blue) stay in "More". */
const CURATED_COLORS: ReadonlyArray<ProjectIconColor> = [
  "gray",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
];

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
 * A project's color as one row of swatches: the curated hues, the current
 * color if it is not one of them, and "More" for the full palette. Arrow keys
 * move between swatches; Enter or Space picks one.
 */
export function ProjectColorPicker(props: {
  readonly value: string | undefined;
  readonly onChange: (value: ProjectIconColor) => void;
  /** Accessible name of the group, such as "Project color". */
  readonly label: string;
  readonly labelledBy?: string;
  readonly disabled?: boolean;
}) {
  const { value, onChange } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const current = value !== undefined ? optionByValue.get(value as ProjectIconColor) : undefined;
  const row = CURATED_COLORS.flatMap((color) => {
    const option = optionByValue.get(color);
    return option ? [option] : [];
  });
  if (current && !CURATED_COLORS.includes(current.value)) row.push(current);
  const groupProps = {
    value: current?.value ?? null,
    disabled: props.disabled,
    onValueChange: (next: unknown) => {
      if (typeof next === "string") onChange(next as ProjectIconColor);
    },
  };

  return (
    <RadioGroupPrimitive
      {...groupProps}
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      className="-mx-1 flex flex-wrap items-center gap-0.5"
    >
      {row.map((option) => (
        <Swatch key={option.value} option={option} />
      ))}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger
          disabled={props.disabled}
          aria-label="More colors"
          render={
            <button
              type="button"
              className={cn(
                "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-(--motion-duration-fast) ease-standard state-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                moreOpen && "state-selected",
              )}
            >
              <EllipsisIcon className="size-4" />
            </button>
          }
        />
        <PopoverPopup side="bottom" align="start" sideOffset={6} padding="compact">
          <RadioGroupPrimitive
            {...groupProps}
            onValueChange={(next) => {
              groupProps.onValueChange(next);
              setMoreOpen(false);
            }}
            aria-label="All colors"
            className="grid grid-cols-6 gap-0.5"
          >
            {PROJECT_ICON_COLORS.map((option) => (
              <Swatch key={option.value} option={option} />
            ))}
          </RadioGroupPrimitive>
        </PopoverPopup>
      </Popover>
    </RadioGroupPrimitive>
  );
}

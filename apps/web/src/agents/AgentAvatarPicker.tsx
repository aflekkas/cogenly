import type { AgentAvatar } from "@cogenly/contracts";
import { ShuffleIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AgentFace, type AgentFaceState } from "~/components/agents/face";
import {
  AVATAR_COLOR_OPTIONS,
  AVATAR_EXPRESSION_OPTIONS,
  AVATAR_SHAPE_OPTIONS,
  avatarFace,
  avatarFaceProps,
  paletteColorId,
  shuffledAvatar,
  withAvatarPart,
  type AvatarFace,
  type AvatarOption,
  type AvatarPart,
} from "~/components/agents/face/agentAvatar.logic";
import { gridNeighbor } from "~/components/projects/projectGrid.logic";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn, randomUUID } from "~/lib/utils";

const OPTION_CELL_CLASS =
  "flex aspect-square items-center justify-center rounded-md outline-none state-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * One pickable row or grid of a face part. Arrow keys, Home and End move focus
 * (one cell is in the tab order), Enter, Space or a click picks, and the focused
 * or hovered cell previews.
 */
function OptionGrid<Option extends AvatarOption<string>>({
  label,
  options,
  columns,
  selected,
  onChoose,
  onPreview,
  renderOption,
}: {
  label: string;
  options: ReadonlyArray<Option>;
  columns: number;
  selected: Option["id"] | null;
  onChoose: (id: Option["id"]) => void;
  onPreview: (id: Option["id"] | null) => void;
  renderOption: (option: Option) => ReactNode;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selected),
  );
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const tabIndex = focusIndex ?? selectedIndex;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = gridNeighbor(tabIndex, event.key, options.length, columns);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    cells.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div
        role="listbox"
        aria-label={label}
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        onKeyDown={onKeyDown}
        onPointerLeave={() => onPreview(null)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusIndex(null);
            onPreview(null);
          }
        }}
      >
        {options.map((option, index) => {
          const isSelected = option.id === selected;
          return (
            <button
              key={option.id}
              ref={(node) => {
                cells.current[index] = node;
              }}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-label={option.label}
              tabIndex={index === tabIndex ? 0 : -1}
              className={cn(OPTION_CELL_CLASS, isSelected && "state-selected")}
              onClick={() => onChoose(option.id)}
              onFocus={() => {
                setFocusIndex(index);
                onPreview(option.id);
              }}
              onPointerEnter={() => onPreview(option.id)}
            >
              {renderOption(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function faceLabels(face: AvatarFace): { shape: string; detail: string } {
  const shape = AVATAR_SHAPE_OPTIONS.find((option) => option.id === face.shape)?.label ?? "";
  const expression =
    AVATAR_EXPRESSION_OPTIONS.find((option) => option.id === face.expression)?.label ?? "";
  const colorId = paletteColorId(face.color);
  const color = AVATAR_COLOR_OPTIONS.find((option) => option.id === colorId)?.label ?? "Custom";
  return { shape, detail: `${expression} · ${color}` };
}

/** The picker's popup: a live preview, shape, expression and colour grids, and Shuffle. */
function AvatarPickerPanel({
  avatar,
  onChange,
}: {
  avatar: AgentAvatar;
  onChange: (avatar: AgentAvatar) => void;
}) {
  const [preview, setPreview] = useState<AvatarPart | null>(null);
  const face = avatarFace(avatar);
  const shown: AvatarFace = { ...face, ...preview };
  const labels = faceLabels(shown);
  const choose = (part: AvatarPart) => onChange(withAvatarPart(avatar, part));
  const previewPart = (part: AvatarPart | null) => setPreview(part);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <AgentFace
          seed={avatar.seed}
          shape={shown.shape}
          color={shown.color}
          expression={shown.expression}
          size={52}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
          <span className="truncate font-medium text-sm">{labels.shape}</span>
          <span className="truncate text-muted-foreground text-xs">{labels.detail}</span>
        </span>
        <Button
          variant="ghost-muted"
          size="xs"
          onClick={() => {
            setPreview(null);
            onChange(shuffledAvatar(randomUUID()));
          }}
        >
          <ShuffleIcon />
          Shuffle
        </Button>
      </div>
      <OptionGrid
        label="Shape"
        options={AVATAR_SHAPE_OPTIONS}
        columns={8}
        selected={face.shape}
        onChoose={(shape) => choose({ shape })}
        onPreview={(shape) => previewPart(shape ? { shape } : null)}
        renderOption={(option) => (
          <AgentFace
            seed={avatar.seed}
            shape={option.id}
            color={face.color}
            expression={face.expression}
            size={24}
          />
        )}
      />
      <OptionGrid
        label="Expression"
        options={AVATAR_EXPRESSION_OPTIONS}
        columns={8}
        selected={face.expression}
        onChoose={(expression) => choose({ expression })}
        onPreview={(expression) => previewPart(expression ? { expression } : null)}
        renderOption={(option) => (
          <AgentFace
            seed={avatar.seed}
            shape={face.shape}
            color={face.color}
            expression={option.id}
            size={24}
          />
        )}
      />
      <OptionGrid
        label="Color"
        options={AVATAR_COLOR_OPTIONS}
        columns={AVATAR_COLOR_OPTIONS.length}
        selected={paletteColorId(face.color)}
        onChoose={(color) => choose({ color })}
        onPreview={(color) => previewPart(color ? { color } : null)}
        renderOption={(option) => (
          <span
            aria-hidden
            className="size-3.5 rounded-full ring-1 ring-foreground/15 ring-inset"
            style={{ backgroundColor: option.hex }}
          />
        )}
      />
    </div>
  );
}

/**
 * Choosing an agent's face. Wrap the triggers, `AgentAvatarTrigger` or any
 * `PopoverTrigger`, in it. Each pick calls `onChange` and the popover stays
 * open, so `avatar` should follow picks at once rather than after a save.
 */
export function AgentAvatarPicker({
  avatar,
  onChange,
  open,
  onOpenChange,
  children,
}: {
  avatar: AgentAvatar;
  onChange: (avatar: AgentAvatar) => void;
  /** Controlled, for callers that open the picker from a menu rather than its trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Popover
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {children}
      <PopoverPopup width="md" padding="compact" align="start" aria-label="Choose face">
        <AvatarPickerPanel avatar={avatar} onChange={onChange} />
      </PopoverPopup>
    </Popover>
  );
}

/** The agent's face as the picker's trigger. */
export function AgentAvatarTrigger({
  avatar,
  size,
  state,
  disabled,
  children,
}: {
  avatar: AgentAvatar;
  size: number;
  state?: AgentFaceState;
  disabled?: boolean;
  /** A visible label beside the face, such as "Choose face". */
  children?: ReactNode;
}) {
  return (
    <PopoverTrigger
      disabled={disabled}
      aria-label={children ? undefined : "Choose face"}
      render={
        <button
          type="button"
          className={cn(
            "group/avatar-trigger inline-flex shrink-0 cursor-pointer items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default",
            children && "pe-2 text-muted-foreground text-xs hover:text-foreground",
          )}
        />
      }
    >
      <span className="rounded-xl transition-transform duration-150 ease-out group-hover/avatar-trigger:scale-105 group-disabled/avatar-trigger:scale-100 motion-reduce:transition-none">
        <AgentFace {...avatarFaceProps(avatar)} {...(state ? { state } : {})} size={size} />
      </span>
      {children}
    </PopoverTrigger>
  );
}

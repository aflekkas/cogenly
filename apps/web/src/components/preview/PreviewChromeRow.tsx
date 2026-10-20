import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Eye,
  Globe,
  Lock,
  MousePointer2,
  MousePointerClick,
  PictureInPicture2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** Who drives a streamed (server) tab; the chrome shows it as one quiet toggle. */
export interface PreviewControlState {
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly canOperate: boolean;
  readonly onToggle: () => void;
}

const CONTROL_PRESENTATION = {
  you: { Icon: MousePointer2, hint: "You have control · click to hand it back" },
  agent: { Icon: MousePointer2, hint: "Agent has control · click to take over" },
  "another-viewer": { Icon: Eye, hint: "Another viewer has control" },
  unclaimed: { Icon: Eye, hint: "Nobody has control · click to take it" },
} as const;

/**
 * The cursor alone says who drives the page: pressed while this viewer does,
 * with a small accent dot while the agent does. The words live in the tooltip
 * and the accessible name.
 */
function PreviewControlToggle({ control }: { control: PreviewControlState }) {
  const { Icon, hint } = CONTROL_PRESENTATION[control.controller];
  if (!control.canOperate) {
    return (
      <span role="status" className="shrink-0 px-1 text-xs text-muted-foreground">
        Read-only
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          size="sm"
          variant="ghost"
          pressed={control.controller === "you"}
          onPressedChange={control.onToggle}
          disabled={control.controller === "another-viewer"}
          aria-label={hint}
          data-preview-control={control.controller}
        >
          <Icon />
          {control.controller === "agent" ? (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
            />
          ) : null}
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

/** The resting address: a lock or globe, the host bright, the rest of the URL muted. */
function parseAddress(url: string): { secure: boolean; host: string; rest: string } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  return { secure: parsed.protocol === "https:", host: parsed.host, rest };
}

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Bumping this value re-focuses and selects the URL input. */
  focusUrlNonce?: number | undefined;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  /** When provided, renders an "Open in browser" affordance to the right. */
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  /**
   * When provided, renders an annotation-mode toggle button to the right of
   * the URL input. Pressed while annotation mode is active (button shows in `pressed`
   * state). Disabled in `pickDisabled` mode.
   */
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  /** Optional reason string surfaced in the disabled tooltip. */
  pickDisabledReason?: string | undefined;
  /** Present on a streamed tab once its control state is known. */
  control?: PreviewControlState | null | undefined;
  /**
   * Trailing slot rendered after the URL input. Used by the preview view
   * to mount the three-dot menu (hard reload, devtools, zoom, clear data).
   */
  trailingActions?: ReactNode;
  /**
   * Slot between the nav buttons and the URL input. The preview view uses it
   * to name the tab's browser profile, which is otherwise invisible.
   */
  leadingActions?: ReactNode;
}

const NOOP = () => {};

/** One ghost icon button of the toolbar's size, with its tooltip. */
function ToolbarButton(props: {
  label: string;
  tooltip?: ReactNode;
  onClick: () => void;
  disabled?: boolean | undefined;
  pressed?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={props.disabled ? NOOP : props.onClick}
            disabled={props.disabled}
            aria-label={props.label}
            aria-pressed={
              props.pressed === undefined ? undefined : props.pressed ? "true" : "false"
            }
            type="button"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The browser's toolbar under the tab strip: a tight nav group, the address,
 * then the page actions, all 28px ghost controls with 8px between the groups.
 * At rest the address reads as text (host bright, path muted); it becomes a
 * field with the full URL on focus and shows its placeholder only on an
 * empty tab.
 */
export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  focusUrlNonce,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  control,
  trailingActions,
  leadingActions,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  const address = url.length > 0 ? parseAddress(url) : null;
  // At rest the field holds nothing and the display beside it shows the URL;
  // the input's own text appears when it is being edited.
  const resting = !inputFocused && url.length > 0;

  useEffect(() => {
    if (focusUrlNonce == null) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
  }, [focusUrlNonce]);

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-2"
        data-surface-subheader
      >
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Navigation">
          <ToolbarButton label="Back" onClick={onBack} disabled={!canGoBack}>
            <ArrowLeft />
          </ToolbarButton>
          <ToolbarButton label="Forward" onClick={onForward} disabled={!canGoForward}>
            <ArrowRight />
          </ToolbarButton>
          <ToolbarButton
            label={loading ? "Stop" : "Refresh"}
            tooltip={loading ? "Loading…" : "Refresh"}
            onClick={onRefresh}
            disabled={refreshDisabled}
          >
            <RefreshIcon refreshing={loading} />
          </ToolbarButton>
        </div>

        {leadingActions}

        <InputGroup variant="ghost" className="group/address relative h-7 min-w-0 flex-1">
          <InputGroupInput
            ref={inputRef}
            value={resting ? "" : inputFocused ? draft : url}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              setDraft(url);
              setInputFocused(true);
              queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => {
              setInputFocused(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(event);
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(url);
                inputRef.current?.blur();
              }
            }}
            placeholder={url.length > 0 ? "" : "Search or enter URL"}
            aria-label={url.length > 0 ? `Address: ${url}` : "Address"}
            spellCheck={false}
            disabled={inputDisabled}
            data-preview-url-input
            size="sm"
          />
          {resting ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center gap-1.5 px-2 text-sm"
            >
              {address ? (
                <>
                  {address.secure ? (
                    <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">
                    <span className="text-foreground">{address.host}</span>
                    <span className="text-muted-foreground">{address.rest}</span>
                  </span>
                </>
              ) : (
                <span className="min-w-0 truncate text-foreground">{url}</span>
              )}
            </div>
          ) : null}
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon align="inline-end">
              {/* Revealed on hover so a resting address bar reads as plain text. */}
              <span className="pointer-events-none flex opacity-0 transition-opacity duration-(--motion-duration-fast) ease-out focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onOpenInBrowser}
                        aria-label="Open in system browser"
                        type="button"
                      />
                    }
                  >
                    <ExternalLink />
                  </TooltipTrigger>
                  <TooltipPopup>Open in system browser</TooltipPopup>
                </Tooltip>
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        {/* Everything that acts on the page rather than the address, as one
            quiet group of ghost controls ending in the overflow menu. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {control ? <PreviewControlToggle control={control} /> : null}
          {onPickElement ? (
            <ToolbarButton
              label={pickActive ? "Cancel annotation" : "Annotate preview"}
              tooltip={
                pickDisabled && pickDisabledReason
                  ? pickDisabledReason
                  : pickActive
                    ? "Cancel annotation (Esc)"
                    : "Annotate elements, regions, and drawings"
              }
              onClick={onPickElement}
              disabled={pickDisabled}
              pressed={pickActive ?? false}
            >
              <MousePointerClick className={cn(pickActive && "text-primary")} />
            </ToolbarButton>
          ) : null}
          {onCapture ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={recording ? "secondary" : "ghost"}
                    size="icon-sm"
                    onClick={(event) => onCapture(event.shiftKey)}
                    aria-label={recording ? "Stop recording" : "Capture screenshot"}
                    type="button"
                    disabled={captureDisabled}
                  />
                }
              >
                <Camera className={cn(recording && "text-destructive")} />
                {recording ? (
                  <span className="absolute top-1 right-1 size-1.5 animate-status-pulse rounded-full bg-destructive" />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup>
                {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {onPictureInPicture ? (
            <ToolbarButton
              label={pictureInPicture ? "Close floating preview" : "Float preview over chat"}
              onClick={onPictureInPicture}
              disabled={pictureInPictureDisabled}
              pressed={pictureInPicture ?? false}
            >
              <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
            </ToolbarButton>
          ) : null}
          {trailingActions}
        </div>
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}

import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  Globe,
  Lock,
  MousePointerClick,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Toggle } from "~/components/ui/toggle";
import { useLastPresent } from "~/components/ui/overlay-presence";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { type PreviewControlInput, resolvePreviewControlToggle } from "./previewControlToggle";

/** Who drives a streamed (server) tab, and the two ways control changes hands. */
export interface PreviewControlState extends PreviewControlInput {
  readonly onTakeControl: () => void;
  readonly onHandBack: () => void;
}

/**
 * The agent toggle (previewControlToggle): pressed and accented while the
 * agent drives, so a click takes control; released and muted while you drive
 * a tab it was using, so a click hands it back. The page banner says the same
 * thing where you would try to use the page. Once shown the toggle keeps its
 * slot and fades, so the toolbar never shifts.
 */
function PreviewControlToggle({ control }: { control: PreviewControlState }) {
  const { controller, canOperate, agentInvolved } = control;
  // Memoized: the last state must keep its identity to survive the fade-out.
  const state = useMemo(
    () => resolvePreviewControlToggle({ controller, canOperate, agentInvolved }),
    [controller, canOperate, agentInvolved],
  );
  const agentState = state.kind === "agent" ? state : null;
  const shown = useLastPresent(agentState);
  if (state.kind === "readOnly") {
    return (
      <span role="status" className="shrink-0 px-1 text-xs text-muted-foreground">
        View only
      </span>
    );
  }
  if (!shown) return null;
  const active = agentState !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-hidden={active ? undefined : true}
            className={cn(
              "flex shrink-0 transition-opacity duration-(--motion-duration-base) ease-out",
              active ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        }
      >
        <Toggle
          size="sm"
          variant="ghost"
          pressed={shown.pressed}
          onPressedChange={() => {
            if (shown.action === "take") control.onTakeControl();
            else if (shown.action === "handBack") control.onHandBack();
          }}
          disabled={shown.disabled || !active}
          aria-label={shown.hint}
          data-preview-control={control.controller}
        >
          {/* Named, not just a robot: it says who drives, and the tooltip what a click does. */}
          <span
            className={cn(
              "flex items-center gap-1 transition-colors duration-(--motion-duration-base) ease-out",
              shown.pressed ? "text-brand-accent" : "text-muted-foreground",
            )}
          >
            <Bot />
            <span className="text-xs font-medium">Agent</span>
          </span>
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup>{shown.hint}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Says an agent drives a tab the desktop renders natively: a status pill, not
 * a button. Those tabs have no stream, so no control toggle; the person takes
 * over by using the page. Once shown it keeps its slot and fades, so the
 * toolbar never shifts.
 */
function AgentUsingTabIndicator({ active }: { active: boolean }) {
  const shownOnce = useLastPresent(active || null);
  if (!shownOnce) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            aria-label={active ? "Agent is using this tab" : undefined}
            aria-hidden={active ? undefined : true}
            data-agent-using-tab={active ? "" : undefined}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 px-1.5 text-xs font-medium text-brand-accent transition-opacity duration-(--motion-duration-base) ease-out",
              active ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        }
      >
        <Bot className="size-4" />
        Agent
      </TooltipTrigger>
      <TooltipPopup>An agent is using this tab · use the page to take over</TooltipPopup>
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
  /** A quiet line beside the annotate toggle, e.g. a pick that captured nothing. */
  pickNotice?: { readonly message: string; readonly leaving: boolean } | null | undefined;
  /** Present on a streamed tab once its control state is known. */
  control?: PreviewControlState | null | undefined;
  /** A natively rendered tab an agent drives; streamed tabs show `control` instead. */
  agentUsingTab?: boolean | undefined;
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

/**
 * One ghost icon button of the toolbar's size, with its tooltip. A button that
 * can't act here names why in `unavailableReason`: it stays hoverable, unlike
 * `disabled`, so the tooltip can say so.
 */
export function ToolbarButton({
  buttonRef,
  ...props
}: {
  label: string;
  tooltip?: ReactNode;
  onClick: () => void;
  disabled?: boolean | undefined;
  unavailableReason?: string | null | undefined;
  pressed?: boolean | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  children: ReactNode;
}) {
  const unavailable = Boolean(props.unavailableReason);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={props.disabled || unavailable ? NOOP : props.onClick}
            disabled={props.disabled}
            aria-disabled={unavailable ? "true" : undefined}
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
      <TooltipPopup>{props.unavailableReason || (props.tooltip ?? props.label)}</TooltipPopup>
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
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  pickNotice,
  control,
  agentUsingTab,
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

        <InputGroup variant="toolbar" className="group/address relative h-7 min-w-0 flex-1">
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
              className="pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center gap-1.5 px-2.5 text-sm"
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
          {pickNotice ? (
            <span
              role="status"
              className={cn(
                "reveal-motion max-w-56 truncate px-1 text-xs text-muted-foreground transition-opacity duration-(--motion-duration-base) ease-out",
                pickNotice.leaving && "opacity-0",
              )}
            >
              {pickNotice.message}
            </span>
          ) : null}
          {control ? (
            <PreviewControlToggle control={control} />
          ) : (
            <AgentUsingTabIndicator active={agentUsingTab === true} />
          )}
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
              <span
                className={cn(
                  "contents transition-colors duration-(--motion-duration-base) ease-out",
                  pickActive && "text-info-foreground",
                )}
              >
                <MousePointerClick />
              </span>
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

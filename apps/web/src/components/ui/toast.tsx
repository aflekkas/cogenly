"use client";

import { Spinner } from "~/components/ui/spinner";

import { Toast } from "@base-ui/react/toast";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

export type ThreadToastData = {
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  leadingIcon?: ReactNode;
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  additionalActions?: ReadonlyArray<{
    id: string;
    props: ComponentPropsWithoutRef<"button">;
  }>;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
  /** Optional extra body shown after toggling “Show details” (e.g. a list of pending RPCs). */
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  /** When set with `expandableContent`, the summary + label act as one text disclosure (no separate chevron row). */
  expandableDescriptionTrigger?: boolean;
  /** Actions sit beside the text by default; `stacked-end` puts them on their own end-aligned row below it. */
  actionLayout?: "inline" | "stacked-end";
  actionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
};

const toastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: Spinner,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

/** Visually shorten long error bodies; clipboard copy still uses the full `description` string. */
const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") {
    return undefined;
  }
  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) {
    return undefined;
  }
  return "line-clamp-4";
}

/**
 * The one dismiss control every toast shares, as in T3 Code: a small round ×
 * "orb" that sits on the card's top-right corner, overhanging it by 6px. It is
 * always visible; the inline action layout leaves end padding so text and
 * actions stay clear of it.
 */
function ToastDismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className={cn(
        // The orb is its own badge: the popover fill and menu hairline
        // (dropdown-glass), cut out of the card corner by a 2px ring in the
        // page colour. The fill stays opaque here so the hover tint on the
        // button blends over it instead of replacing it.
        "dropdown-glass absolute -top-1.5 -right-1.5 z-20 size-6 rounded-full shadow-sm ring-2 ring-background",
        "transition-shadow duration-(--motion-duration-fast) ease-standard hover:shadow-md motion-reduce:transition-none",
      )}
    >
      <button
        aria-label="Dismiss notification"
        className={cn(
          "inline-flex size-full cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none",
          "transition-colors duration-(--motion-duration-fast) ease-standard hover:bg-accent hover:text-foreground motion-reduce:transition-none",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        data-slot="toast-close"
        onClick={onDismiss}
        type="button"
      >
        <XIcon className="size-3" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function handleToastDismissClick(toastId: ToastId, onClose: (() => void) | undefined) {
  onClose?.();
  toastManager.close(toastId);
}

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-message" });
  const label = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            className="[--control-icon-color:currentColor] rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
            onClick={() => copyToClipboard(text)}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-success")}
          icon={isCopied ? Check : Copy}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Scrollable cap for long expandable lists (~10rem); keeps the toast from growing without bound. */
const toastExpandablePanelClassName =
  "mt-2 max-h-40 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const [open, setOpen] = useState(false);
  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <MorphIcon
          className="size-3.5 shrink-0 opacity-80"
          icon={open ? ChevronUp : ChevronDown}
          strokeWidth={2.25}
        />
        {open ? collapseLabel : expandLabel}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

function ToastDescriptionAndExpandable({
  toastData,
  toastDescription,
  toastType,
}: {
  toastData: ThreadToastData | undefined;
  toastDescription: unknown;
  toastType: unknown;
}) {
  const expandableContent = toastData?.expandableContent;
  const labels = toastData?.expandableLabels ?? {};
  const descriptionTrigger = toastData?.expandableDescriptionTrigger ?? false;
  const descriptionClassName = cn(
    "min-w-0 select-text wrap-break-word text-muted-foreground",
    errorDescriptionClampClass(toastType, toastDescription),
  );
  const [open, setOpen] = useState(false);

  if (!expandableContent) {
    return <Toast.Description className={descriptionClassName} data-slot="toast-description" />;
  }

  if (!descriptionTrigger) {
    return (
      <>
        <Toast.Description className={descriptionClassName} data-slot="toast-description" />
        <ToastExpandableSection labels={labels}>{expandableContent}</ToastExpandableSection>
      </>
    );
  }

  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              aria-label={open ? collapseLabel : expandLabel}
              aria-expanded={open}
              className={cn(
                "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none ring-offset-background",
                "transition-colors hover:bg-muted/40",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              )}
              onClick={toggle}
              onKeyDown={onKeyDown}
              role="button"
              tabIndex={0}
            />
          }
        >
          <div className="min-w-0 flex-1">
            <Toast.Description
              className={cn(
                "min-w-0 select-none wrap-break-word text-muted-foreground",
                errorDescriptionClampClass(toastType, toastDescription),
                "underline-offset-2 decoration-muted-foreground/60 group-hover:underline",
              )}
              data-slot="toast-description"
            />
          </div>
          <MorphIcon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
            icon={open ? ChevronUp : ChevronDown}
            strokeWidth={2.25}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{open ? collapseLabel : expandLabel}</TooltipPopup>
      </Tooltip>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

type ToastCardToast = {
  readonly id: ToastId;
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly actionProps?: ComponentPropsWithoutRef<"button"> | undefined;
  readonly data?: ThreadToastData | undefined;
};

/**
 * The single toast card: icon slot, title, description, the actions beside the
 * text (or on an end-aligned row below it with `actionLayout: "stacked-end"`),
 * and the × orb on the corner. Every notice in the app renders through it,
 * with the same padding, typography and controls.
 */
function ToastCard({
  toast,
  onDismiss,
  className,
}: {
  toast: ToastCardToast;
  onDismiss: () => void;
  className?: string;
}) {
  const data = toast.data;
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const leadingIcon = data?.leadingIcon;
  const copyErrorText =
    toast.type === "error" && typeof toast.description === "string" && !data?.hideCopyButton
      ? toast.description
      : null;
  const additionalActions = data?.additionalActions ?? [];
  const secondaryActionProps = data?.secondaryActionProps;
  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};
  const secondaryActionVariant = data?.secondaryActionVariant ?? "outline";
  const hasPrimaryAction = hasVisibleToastAction(toast.actionProps);
  const hasActions =
    copyErrorText !== null ||
    hasPrimaryAction ||
    additionalActions.length > 0 ||
    secondaryActionProps !== undefined;
  const stackedActionLayout = hasActions && data?.actionLayout === "stacked-end";

  return (
    <>
      <ToastDismissButton onDismiss={onDismiss} />
      <Toast.Content
        className={cn(
          // `overflow-x: clip` avoids the CSS quirk where pairing `hidden` + `y: visible`
          // forces `y` to `auto`. Expandable detail panels can extend below without being cut off.
          "pointer-events-auto flex min-h-0 overflow-y-visible pl-3.5 text-sm [overflow-x:clip]",
          // Inline: text and actions share one row. The end padding keeps
          // whatever sits last clear of the corner orb (which overhangs 18px).
          stackedActionLayout
            ? "flex-col gap-2 py-2.5 pr-3.5"
            : cn("items-center justify-between gap-1.5 py-3", hasActions ? "pr-6" : "pr-10"),
          className,
        )}
      >
        <div
          className={cn("flex min-w-0 flex-col gap-0.5", stackedActionLayout ? "pr-5" : "flex-1")}
        >
          <div className="flex min-w-0 gap-2">
            {leadingIcon || Icon ? (
              <div
                className="flex h-lh w-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                data-slot="toast-icon"
              >
                {leadingIcon ??
                  (Icon ? (
                    <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80" />
                  ) : null)}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Toast.Title
                className="min-w-0 wrap-break-word font-medium text-foreground"
                data-slot="toast-title"
              />
              <ToastDescriptionAndExpandable
                toastData={data}
                toastDescription={toast.description}
                toastType={toast.type}
              />
            </div>
          </div>
        </div>
        {hasActions ? (
          <div
            className={cn(
              "flex items-center gap-1.5",
              stackedActionLayout ? "w-full flex-wrap justify-end" : "shrink-0",
            )}
          >
            {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
            {additionalActions.map(({ id, props: { className: actionClassName, ...props } }) => (
              <Button
                {...props}
                className={actionClassName}
                key={id}
                size="xs"
                type="button"
                variant={secondaryActionVariant}
              />
            ))}
            {secondaryActionProps ? (
              <Button
                {...secondaryActionRest}
                className={secondaryActionClassName}
                size="xs"
                type="button"
                variant={secondaryActionVariant}
              />
            ) : null}
            {hasPrimaryAction ? (
              <Toast.Action
                className={cn(
                  buttonVariants({ size: "xs", variant: data?.actionVariant ?? "default" }),
                  "shrink-0",
                )}
                data-slot="toast-action"
              >
                {toast.actionProps?.children}
              </Toast.Action>
            ) : null}
          </div>
        ) : null}
      </Toast.Content>
    </>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") {
      return routeTarget.threadRef;
    }
    if (routeTarget?.kind === "draft" && activeDraftSession) {
      return {
        environmentId: activeDraftSession.environmentId,
        threadId: activeDraftSession.threadId,
      };
    }
    return null;
  }, [activeDraftSession, routeTarget]);
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-center", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {/* One tooltip group for the app: once a tooltip has been shown, the next trigger reached
          within the timeout opens at once without replaying the entrance, as on macOS. */}
      <TooltipProvider delay={500} closeDelay={0} timeout={400}>
        {children}
      </TooltipProvider>
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderThreadScopedToast(toast.data, activeThreadRef),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          // Vertical positioning: just below the window's top edge, clear of
          // the desktop window controls (--toast-top-offset, index.css).
          "data-[position*=top]:top-(--toast-top-offset)",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:inset-x-0",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );

          return (
            <Toast.Root
              className={cn(
                "dropdown-glass surface-raised surface-raised-floating absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-lg text-popover-foreground [transition:transform_var(--motion-duration-slow)_var(--motion-ease-standard),opacity_var(--motion-duration-slow)_var(--motion-ease-standard),height_.15s] motion-reduce:transition-none",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // `--toast-calc-height`: behind + collapsed = peek height only (content `opacity-0`);
                // max(front, own) there produced a tall empty shell for long bodies.
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Root height: never `min-h-(--toast-height)` — Base UI measures height by briefly forcing
                // `height: auto` on this node; an old `min-height` from `--toast-height` blocks shrinking,
                // so `recalculateHeight` keeps the inflated value after an expandable closes.
                // Behind + collapsed: fixed peek. Otherwise natural height (expand/collapse, hover stack).
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded stack
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                // Toasts fade in and out where they sit; nothing slides in.
                // Only a swipe dismiss carries the toast off in its direction.
                "data-starting-style:opacity-0",
                "data-ending-style:opacity-0",
                // Swipe-dismiss animations (direction-aware)
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <ToastCard
                className={cn(
                  "transition-opacity duration-250 data-expanded:opacity-100",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
                onDismiss={() => handleToastDismissClick(toast.id, toast.data?.onClose)}
                toast={toast}
              />
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { hiddenToastActionProps, stackedThreadToast } from "./toastHelpers";
export type { StackedThreadToastOptions } from "./toastHelpers";

export { ToastProvider, type ToastPosition, toastManager };

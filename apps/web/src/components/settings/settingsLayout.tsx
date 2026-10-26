import { SettingsGroup } from "./SettingsGroup";
import { AuthSettingsWriteScope } from "@cogenly/contracts";
import { usePrimaryEnvironmentId, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { InfoIcon, PlusIcon, Undo2Icon } from "lucide-react";
import {
  DEFAULT_SERVER_SETTINGS,
  isUniversalServerSettingKey,
  type ServerSettings,
} from "@cogenly/contracts";
import * as Equal from "effect/Equal";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
  usePrimarySettingsAvailable,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getRelativeTimeState } from "../../timestampFormat";
import { PageContent } from "../PageContent";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/disclosure";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { MachineScopeMenu, SettingsScopeSentence } from "./SettingsScopeSentence";
import { selectMachineLocalSettingsTargets } from "./scopedSettings";
import { SettingInheritance } from "./SettingInheritance";

const EMPTY_SETTING_KEYS: readonly (keyof ServerSettings)[] = [];

declare module "@tanstack/react-router" {
  interface HistoryState {
    settingsTargetHighlight?: boolean;
  }
}

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly highlightTarget: boolean;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  highlightTarget: true,
  onTargetHandled: noop,
});

function SettingsSearchTargetProvider({
  targetId,
  highlightTarget = true,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  highlightTarget?: boolean;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ targetId, highlightTarget, onTargetHandled }),
    [highlightTarget, onTargetHandled, targetId],
  );
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement, highlight = true): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const markedScrollTarget =
    typeof target.querySelector === "function"
      ? target.querySelector<HTMLElement>(":scope > [data-settings-scroll-target]")
      : null;
  const scrollTarget =
    markedScrollTarget ??
    (target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target);

  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center",
  });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (!highlight || prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** The row id a settings-search jump is currently trying to reach, if any. */
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

export function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, highlightTarget, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target, highlightTarget);
        onTargetHandled();
      }
    },
    [highlightTarget, isSearchTarget, onTargetHandled],
  );

  return targetRef;
}

export function SettingsSearchTarget({
  children,
  ...targetProps
}: ComponentPropsWithoutRef<"div">) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(targetProps.id);
  return (
    <div {...targetProps} ref={targetRef} tabIndex={targetProps.id ? -1 : targetProps.tabIndex}>
      {children}
    </div>
  );
}

/** Layout for the composer model/traits pickers in a settings row: drop the composer's max-width. */
export const SETTINGS_PICKER_TRIGGER_CLASSNAME = "min-w-0 max-w-none shrink-0";

/** Info affordance explaining how a setting interacts with the shared background policy. */
export function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label="Background policy details">
            <InfoIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

/**
 * The heading row above a section's card: a muted title (with an optional
 * leading icon), an optional small control right after it, and the section's
 * actions on the right. `title` may be a fold's trigger.
 */
export function SettingsSectionHeader({
  title,
  icon,
  titleAction,
  headerAction,
}: {
  title: ReactNode;
  icon?: ReactNode;
  titleAction?: ReactNode;
  headerAction?: ReactNode;
}) {
  return (
    <div
      data-settings-scroll-target
      className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
    >
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="flex min-h-7 min-w-0 items-center gap-2 text-sm font-normal text-foreground/70">
          {icon}
          {title}
        </h2>
        {titleAction}
      </div>
      <div className="flex min-h-7 min-w-7 items-center justify-end gap-1.5">{headerAction}</div>
    </div>
  );
}

/**
 * One titled card of settings. Headings are short nouns in sentence case with
 * no description; explanatory copy belongs to the rows, and anything that
 * applies to the whole section goes in `footer`, a muted note under the card.
 */
export function SettingsSection({
  title,
  hideTitle = false,
  icon,
  titleAction,
  headerAction,
  footer,
  variant = "grouped",
  children,
  className,
  ...sectionProps
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title: ReactNode;
  hideTitle?: boolean;
  icon?: ReactNode;
  /** Small control shown right after the title, such as an icon-only add button. */
  titleAction?: ReactNode;
  /** The section's actions: a `SettingsSectionAction`, a refresh, a menu. */
  headerAction?: ReactNode;
  footer?: ReactNode;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn(!hideTitle && "space-y-2.5", className)}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <SettingsSectionHeader
          title={title}
          icon={icon}
          titleAction={titleAction}
          headerAction={headerAction}
        />
      )}
      <SettingsGroup data-settings-scroll-target={hideTitle ? "" : undefined} variant={variant}>
        {children}
      </SettingsGroup>
      {footer ? <SettingsFootnote>{footer}</SettingsFootnote> : null}
    </section>
  );
}

/** A muted note under a card, aligned with the section heading. */
function SettingsFootnote({ children }: { children: ReactNode }) {
  return <p className="px-3 pt-0.5 text-xs text-muted-foreground sm:px-4">{children}</p>;
}

/**
 * A section's labelled header action, the one that adds to its list ("Add
 * item", "New task"). Pass `icon={null}` for an action that doesn't add.
 */
export function SettingsSectionAction({
  icon: Icon = PlusIcon,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
  icon?: ComponentType<{ className?: string }> | null;
}) {
  return (
    <Button {...props} size="xs" variant="ghost-muted">
      {Icon ? <Icon aria-hidden className="size-3" /> : null}
      {children}
    </Button>
  );
}

/**
 * A section's refresh, in its header: a quiet button that says when the data
 * was last checked (or `idleLabel` when nothing has been checked), and
 * "Refreshing" while it runs. `label` names the action for the tooltip and
 * assistive tech.
 */
export function SettingsRefreshAction({
  label,
  refreshing,
  disabled = false,
  checkedAt,
  idleLabel = "Refresh",
  onRefresh,
}: {
  label: string;
  refreshing: boolean;
  disabled?: boolean;
  /** ISO time of the last check; omit for data that has no check time. */
  checkedAt?: string | null;
  idleLabel?: string;
  onRefresh: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={refreshing || disabled}
            aria-busy={refreshing}
            onClick={onRefresh}
          >
            <RefreshIcon refreshing={refreshing} />
            <span className="sr-only">{label}</span>
            <span aria-hidden className="hidden min-w-0 truncate sm:inline">
              {refreshing ? (
                "Refreshing"
              ) : (
                <LastCheckedLabel checkedAt={checkedAt ?? null} idleLabel={idleLabel} />
              )}
            </span>
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function LastCheckedLabel({
  checkedAt,
  idleLabel,
}: {
  checkedAt: string | null;
  idleLabel: string;
}) {
  useRelativeTimeTick();
  const relative = getRelativeTimeState(checkedAt);
  if (relative.status === "missing") return <>{idleLabel}</>;
  if (relative.status === "invalid") return <>Checked unavailable</>;
  return relative.suffix ? (
    <>
      Checked <span className="font-mono tabular-nums">{relative.value}</span> {relative.suffix}
    </>
  ) : (
    <>Checked {relative.value}</>
  );
}

/** Search and filters for a section's list, as the first row of its card. */
export function SettingsToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4", className)}
    />
  );
}

/**
 * A muted line inside a card, padded like a row: a list summary, "N more",
 * or why a list is partial. Use `SettingsEmpty` for a list with nothing in it.
 */
export function SettingsNote({
  tone = "muted",
  className,
  ...props
}: ComponentProps<"p"> & { tone?: "muted" | "destructive" }) {
  return (
    <p
      {...props}
      className={cn(
        "px-3 py-2.5 text-xs sm:px-4",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    />
  );
}

/**
 * An empty list inside a card. `default` for the main list of a page,
 * `sm` for a secondary list. Loading and failures are `SettingsRow`s with a
 * title ("Loading memory…", "Could not load memory") instead.
 */
export function SettingsEmpty({
  icon,
  title,
  description,
  action,
  size = "default",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: "default" | "sm";
}) {
  return (
    <Empty size={size}>
      <EmptyHeader>
        {icon ? <EmptyMedia>{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/** A page whose sections can't show yet: one status line where they would be. */
export function SettingsPageMessage({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
      {children}
    </p>
  );
}

/**
 * A fold inside a card: a header row with the disclosure chevron, a title, a
 * one-line summary and an optional control, over rows that are divided like
 * the card's own. A settings search that targets `id`, or one of `targetIds`
 * inside it, opens it.
 */
export function SettingsDisclosure({
  id,
  targetIds,
  title,
  summary,
  control,
  children,
}: {
  id?: string;
  targetIds?: readonly string[];
  title: ReactNode;
  summary?: ReactNode;
  control?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useSearchTargetFold(id, targetIds);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-4 px-3 sm:px-4">
        <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <DisclosureChevron />
          <span className="shrink-0 text-sm font-medium">{title}</span>
          {summary ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
          ) : null}
        </CollapsibleTrigger>
        {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
      </div>
      <CollapsiblePanel>
        <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
          {children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Open state for a fold that a settings-search jump can land in. A jump to
 * `id` or one of `targetIds` opens it once, so the user can still fold it
 * back while the target is set; a later jump opens it again.
 */
export function useSearchTargetFold(
  id: string | undefined,
  targetIds: readonly string[] = [],
): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const [handledTarget, setHandledTarget] = useState<string | null>(null);
  const wantsOpen =
    searchTargetId !== null && (searchTargetId === id || targetIds.includes(searchTargetId));
  if (wantsOpen && handledTarget !== searchTargetId) {
    setHandledTarget(searchTargetId);
    if (!open) setOpen(true);
  } else if (searchTargetId === null && handledTarget !== null) {
    setHandledTarget(null);
  }
  return [open, setOpen];
}

/** A number with its unit after it ("60 seconds"), sized for a settings row's control. */
export function SettingsNumberField({
  label,
  unit,
  value,
  min,
  step,
  onValueChange,
}: {
  /** Names the value in the stepper labels: "Decrease {label}", "{label} in {unit}". */
  label: string;
  unit: string;
  value: number;
  min?: number;
  step?: number;
  onValueChange: (value: number | null) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <NumberField
        value={value}
        {...(min === undefined ? {} : { min })}
        {...(step === undefined ? {} : { step })}
        size="sm"
        className="w-32"
        onValueChange={onValueChange}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label}`} />
          <NumberFieldInput aria-label={`${label} in ${unit}`} />
          <NumberFieldIncrement aria-label={`Increase ${label}`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

export function SettingsUnavailableGroup({
  children,
  message,
}: {
  children: ReactNode;
  message?: ReactNode;
}) {
  if (message === undefined) return children;

  return (
    <div className="border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-xs leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>{message}</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

/**
 * One setting. `serverScoped` marks rows whose value lives in the primary
 * environment's settings.json; where there is no primary (the hosted app)
 * the control goes inert with a tooltip instead of showing an editable
 * default that would never save.
 *
 * Keep descriptions short enough for one line where possible. Allow wrapping
 * for clarity or narrow screens instead of truncating or forcing no-wrap.
 *
 * Control sizing across settings follows three tiers so rows share a baseline:
 * - `control` slot: `size="sm"` (Button, Select, Input, NumberField) or `icon-sm`.
 * - Section `headerAction`s and buttons inside list items, cards, toolbars: `xs` / `icon-xs`.
 * - Inline affordances (reset arrows, info tooltips, table-cell buttons): `icon-micro`.
 * Dialog footers keep the app-wide default button size.
 */
export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  serverScoped = false,
  settingKeys = EMPTY_SETTING_KEYS,
  interactive = false,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  serverScoped?: boolean;
  settingKeys?: readonly (keyof ServerSettings)[];
  interactive?: boolean;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);
  const primarySettingsAvailable = usePrimarySettingsAvailable();
  const context = useOptionalSettingsScope();
  const machineLocal =
    settingKeys.length > 0 && !settingKeys.some((key) => isUniversalServerSettingKey(key));
  const rowEnvironments = context
    ? machineLocal
      ? selectMachineLocalSettingsTargets(context.scope, context.connectedEnvironments)
      : context.connectedEnvironments
    : [];
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryCanWrite = useEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope);
  const writableIds = useEnvironmentsWithScope(rowEnvironments, AuthSettingsWriteScope);
  const canWriteSettings = context
    ? rowEnvironments.length > 0 &&
      rowEnvironments.every((target) => writableIds.has(target.environmentId))
    : primaryCanWrite;
  const unavailable =
    serverScoped &&
    (!canWriteSettings || !(context ? rowEnvironments.length > 0 : primarySettingsAvailable));
  // A machine-local row on a page about every machine names the machine it changes.
  const machineLabel =
    context !== null &&
    serverScoped &&
    machineLocal &&
    !context.machinePage &&
    context.environments.length > 1 ? (
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        on <MachineScopeMenu />
      </span>
    ) : null;
  const machineName = context?.environment?.label ?? "this machine";
  const renderedReset = unavailable ? null : resetAction;
  const inertControl = (message: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          // Focusable so keyboard users can still reach the explanation.
          <span
            tabIndex={0}
            className="flex w-full items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[32rem]/settings-row:w-auto"
          />
        }
      >
        <div
          inert
          className="flex w-full items-center gap-2 opacity-50 @min-[32rem]/settings-row:w-auto"
        >
          {control}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top">{message}</TooltipPopup>
    </Tooltip>
  );
  const renderedControl =
    unavailable && control
      ? inertControl(
          !canWriteSettings
            ? `This connection lacks permission to change settings on ${
                context
                  ? rowEnvironments
                      .filter((target) => !writableIds.has(target.environmentId))
                      .map((target) => target.label)
                      .join(", ") || "the selected machine"
                  : (primaryEnvironment?.label ?? "the primary machine")
              }.`
            : context
              ? `Reconnect ${machineName} to change this setting.`
              : PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
        )
      : control;
  // Server rows get an indicator beside the title that opens the resolution
  // chain; client rows keep a plain status only.
  const key = settingKeys[0];
  const target = context?.target ?? null;
  const customized =
    target !== null &&
    settingKeys.some(
      (settingKey) =>
        !Equal.equals(target.settings[settingKey], DEFAULT_SERVER_SETTINGS[settingKey]),
    );
  const renderedInheritance =
    context && serverScoped && key !== undefined && target !== null ? (
      <SettingInheritance
        state={customized ? "environment" : "default"}
        summary={
          customized
            ? machineLocal
              ? `Set on ${machineName}`
              : "Set for all machines"
            : "Built-in default"
        }
        target={target}
        environment={context.connectedEnvironments.find(
          (environment) => environment.environmentId === target.environmentId,
        )}
        settingKey={key}
      />
    ) : null;

  return (
    <SettingsRowContent
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      title={title}
      description={description}
      status={status}
      control={renderedControl}
      interactive={interactive}
      className={className}
      titleActions={
        <>
          {renderedInheritance ? (
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {renderedInheritance}
            </span>
          ) : null}
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            {renderedReset}
          </span>
          {machineLabel}
        </>
      }
    >
      {unavailable && children ? (
        <div inert className="opacity-50">
          {children}
        </div>
      ) : (
        children
      )}
    </SettingsRowContent>
  );
}

/** Shared row presentation without settings subscriptions, also used by content lists. */
export function SettingsRowContent({
  title,
  description,
  status,
  titleActions,
  control,
  children,
  interactive = false,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  titleActions?: ReactNode;
  control?: ReactNode;
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      {...rowProps}
      data-slot="settings-row"
      className={cn(
        "@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground",
        children ? "pt-3 pb-1" : "py-3",
        interactive &&
          "cursor-pointer outline-none transition-opacity duration-(--motion-duration-fast) ease-out hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="min-w-0 text-sm font-medium text-foreground">{title}</h3>
            {titleActions}
          </div>
          {description ? (
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({
  label,
  tooltip = "Reset to default",
  disabled = false,
  onClick,
}: {
  label: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Reset ${label} to default`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The one frame every settings page renders in, owned by the settings route
 * layout: the page scroller, the content column's width and padding, and the
 * scope sentence. Pages return their sections and never set their own width;
 * size page content with `@container/settings-page` queries instead of
 * viewport breakpoints.
 */
export function SettingsPageContainer({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const highlightTarget = useLocation({
    select: (location) => location.state.settingsTargetHighlight !== false,
  });
  const targetId = hash.replace(/^#/, "") || null;
  const clearTargetHash = useCallback(() => {
    void navigate({
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  }, [navigate]);

  return (
    <SettingsSearchTargetProvider
      targetId={targetId}
      highlightTarget={highlightTarget}
      onTargetHandled={clearTargetHash}
    >
      <div
        // overflow-x-hidden: the page frame glides sideways when a panel toggles.
        className="scroll-fade-y scrollbar-gutter-both flex-1 overflow-x-hidden overflow-y-auto"
        data-settings-page-scroll
      >
        <PageContent className="@container/settings-page gap-8">
          <SettingsScopeSentence />
          {children}
        </PageContent>
      </div>
    </SettingsSearchTargetProvider>
  );
}

/** Back to the top of the settings page, for a sub-page swapped in by search. */
export function resetSettingsPageScroll(): void {
  document.querySelector("[data-settings-page-scroll]")?.scrollTo({ top: 0 });
}

export function scrollToSettingsTarget(
  targetId: string,
  { highlight = true }: { readonly highlight?: boolean } = {},
): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target, highlight);
  return true;
}

"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@cogenly/contracts";
import {
  type CustomModelDefinition,
  findReasoningEffortDescriptor,
  normalizeCustomModelSlug,
} from "@cogenly/shared/model";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button, InlineButton } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CustomModelEditor } from "./CustomModelEditor";
import {
  SETTINGS_MICRO_LABEL_CLASSNAME,
  SettingsDenseList,
  SettingsDenseRow,
  SettingsEmpty,
  SettingsSection,
  SettingsSectionAction,
  SettingsToolbar,
} from "./settingsLayout";
import { SettingsListSearch } from "./SettingsList";
import { SettingsTag } from "./SettingsStatus";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged; only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
};

/** Above this many models the list gets a filter input. */
const FILTER_THRESHOLD = 8;

/**
 * Short capability words shown after a model's slug. Claude and Cursor report
 * fast mode as a boolean `fastMode` option; Codex reports it as a
 * `serviceTier` select whose fast tier is labelled "Fast" (catalog id
 * `priority`, or `fast` from the speed-tier fallback), matching the composer.
 */
function describeModelCapabilities(model: ServerProviderModel): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const labels: string[] = [];
  const hasFastMode = descriptors.some(
    (descriptor) =>
      descriptor.id === "fastMode" ||
      (descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        descriptor.options.some((option) => option.id === "fast" || option.label === "Fast")),
  );
  if (hasFastMode) labels.push("Fast mode");
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) labels.push("Thinking");
  if (
    descriptors.some(
      (descriptor) =>
        descriptor.type === "select" &&
        (descriptor.id === "reasoningEffort" ||
          descriptor.id === "effort" ||
          descriptor.id === "reasoning" ||
          descriptor.id === "variant"),
    )
  ) {
    labels.push("Reasoning");
  }
  return labels;
}

/**
 * Display order for the models list: visible models in user order, then
 * hidden ones. Hidden models sink so the list reads
 * top-down as "what the picker shows"; moves only swap rows within the same
 * group, and the resulting display order is what gets persisted as
 * `modelOrder`.
 */
export function groupModelsForDisplay<
  T extends { readonly slug: string; readonly isCustom: boolean },
>(
  models: ReadonlyArray<T>,
  options: {
    readonly hiddenModels: ReadonlySet<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): T[] {
  const ordered = sortModelsForProviderInstance(models, { modelOrder: options.modelOrder });
  const isHidden = (model: T) => !model.isCustom && options.hiddenModels.has(model.slug);
  return [
    ...ordered.filter((model) => !isHidden(model)),
    ...ordered.filter((model) => isHidden(model)),
  ];
}

export function nextHiddenModelsForBulkToggle(
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom">>,
  hiddenModels: ReadonlyArray<string>,
): string[] {
  const builtInSlugs = models.filter((model) => !model.isCustom).map((model) => model.slug);
  const builtInSlugSet = new Set(builtInSlugs);
  const allBuiltInModelsHidden = builtInSlugs.every((slug) => hiddenModels.includes(slug));

  if (allBuiltInModelsHidden) {
    return hiddenModels.filter((slug) => !builtInSlugSet.has(slug));
  }

  return [...new Set([...hiddenModels, ...builtInSlugs])];
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model list for this instance, resolved. Drives
   * dedup, and is the list we hand back (with an entry appended / replaced /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
  readonly canManageCustomModels: boolean;
  readonly canWritePreferences?: boolean;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<CustomModelDefinition>) => void;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels?: ReadonlyArray<string>,
  ) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  /** Per-model default reasoning effort chosen by the user, keyed by slug. */
  readonly effortDefaults?: Readonly<Record<string, ProviderOptionSelection>>;
  /** Sets (or with `null`, resets to the model's own default) one model's starting effort. */
  readonly onEffortDefaultChange?: (slug: string, option: ProviderOptionSelection | null) => void;
}

const MODEL_DEFAULT_EFFORT = "__model-default";

/**
 * The effort a model starts at in new chats and Work, chosen per model. Only
 * models whose catalog offers a reasoning effort get one.
 */
function ModelEffortDefaultSelect(props: {
  readonly model: ServerProviderModel;
  readonly configured: ProviderOptionSelection | undefined;
  readonly disabled: boolean;
  readonly onChange: (option: ProviderOptionSelection | null) => void;
}) {
  const descriptor = findReasoningEffortDescriptor(props.model.capabilities);
  if (!descriptor) return null;
  const configured =
    props.configured?.id === descriptor.id &&
    typeof props.configured.value === "string" &&
    descriptor.options.some((option) => option.id === props.configured?.value)
      ? props.configured.value
      : null;
  const value = configured ?? MODEL_DEFAULT_EFFORT;
  const label =
    configured === null
      ? "Default effort"
      : (descriptor.options.find((option) => option.id === configured)?.label ?? configured);
  return (
    <Select
      disabled={props.disabled}
      value={value}
      onValueChange={(next) => {
        if (next === value) return;
        props.onChange(
          next === MODEL_DEFAULT_EFFORT || next === null
            ? null
            : { id: descriptor.id, value: String(next) },
        );
      }}
    >
      <SelectTrigger
        size="xs"
        variant="ghost"
        className="w-auto"
        aria-label={`Default reasoning effort for ${props.model.name}`}
      >
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={MODEL_DEFAULT_EFFORT}>
          Model default
        </SelectItem>
        {descriptor.options.map((option) => (
          <SelectItem hideIndicator key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  canManageCustomModels,
  canWritePreferences = true,
  hiddenModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onModelOrderChange,
  effortDefaults,
  onEffortDefaultChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Slug of the custom model whose inline editor is open, if any.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Slug of a just-added custom model, scrolled into view once its row exists.
  const scrollToSlugRef = useRef<string | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const displayModels = useMemo(
    () =>
      groupModelsForDisplay(models, {
        hiddenModels: hiddenModelSet,
        modelOrder,
      }),
    [hiddenModelSet, modelOrder, models],
  );
  const hiddenCount = displayModels.filter(
    (model) => !model.isCustom && hiddenModelSet.has(model.slug),
  ).length;
  const builtInModels = useMemo(() => models.filter((model) => !model.isCustom), [models]);
  const allBuiltInModelsHidden =
    builtInModels.length > 0 && builtInModels.every((model) => hiddenModelSet.has(model.slug));
  const showFilter = models.length > FILTER_THRESHOLD;
  const normalizedFilter = filter.trim().toLowerCase();
  const isFiltering = showFilter && normalizedFilter.length > 0;
  const visibleModels = isFiltering
    ? displayModels.filter(
        (model) =>
          model.name.toLowerCase().includes(normalizedFilter) ||
          model.slug.toLowerCase().includes(normalizedFilter),
      )
    : displayModels;

  // The parent commits the new custom model and hands back an updated
  // `models` list, so the row can only be scrolled to after that render. Runs
  // after every render and returns at once unless a scroll is pending.
  useEffect(() => {
    const slug = scrollToSlugRef.current;
    if (slug === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-model-slug="${CSS.escape(slug)}"]`,
    );
    if (!row) return;
    scrollToSlugRef.current = null;
    row.scrollIntoView({ block: "nearest" });
  });

  const handleAdd = () => {
    if (!canManageCustomModels) return;
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.some((entry) => entry.slug === normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    // Clear the filter so the new row renders even when it does not match,
    // which is also what lets the pending scroll target resolve and clear.
    scrollToSlugRef.current = normalized;
    setFilter("");
    onChange([...customModels, { slug: normalized, name: normalized, capabilities: null }]);
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const cancelAdd = () => {
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const handleRemove = async (slug: string) => {
    if (!canManageCustomModels) return;
    const message = `Remove ${slug}?\nIt leaves the model picker and its options are lost.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    if (editingSlug === slug) setEditingSlug(null);
    onChange(customModels.filter((entry) => entry.slug !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    setError(null);
  };

  const handleSaveEdit = (next: CustomModelDefinition) => {
    if (!canManageCustomModels) return;
    onChange(customModels.map((entry) => (entry.slug === next.slug ? next : entry)));
    setEditingSlug(null);
  };

  const setHidden = (slug: string, hidden: boolean) => {
    if (!canWritePreferences || hidden === hiddenModelSet.has(slug)) return;
    onHiddenModelsChange(
      hidden ? [...hiddenModels, slug] : hiddenModels.filter((model) => model !== slug),
      [slug],
    );
  };

  // Rows only trade places with a neighbour in the same group (visible,
  // hidden), and the display order is persisted as the new order.
  const groupOf = (model: (typeof displayModels)[number]) =>
    !model.isCustom && hiddenModelSet.has(model.slug) ? "hidden" : "visible";
  const handleMove = (slug: string, direction: -1 | 1) => {
    if (!canWritePreferences) return;
    const index = displayModels.findIndex((model) => model.slug === slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= displayModels.length) return;
    if (groupOf(displayModels[index]!) !== groupOf(displayModels[nextIndex]!)) return;
    const next = displayModels.map((model) => model.slug);
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  type DisplayModel = (typeof displayModels)[number];

  // Reorder and remove stay in the row at all times (dimmed when unavailable)
  // so ordering is discoverable without hovering.
  const rowActions = (
    model: DisplayModel,
    options: {
      readonly isHidden: boolean;
      readonly canMoveUp: boolean;
      readonly canMoveDown: boolean;
    },
  ) => (
    // At least as wide as a custom row's four buttons, so the effort pickers
    // end on one edge across built-in and custom rows.
    <span className="flex min-w-22 shrink-0 items-center justify-end gap-0.5">
      {!options.isHidden && !isFiltering ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={!canWritePreferences || !options.canMoveUp}
                  onClick={() => handleMove(model.slug, -1)}
                  aria-label={`Move ${model.name} up`}
                />
              }
            >
              <ArrowUpIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move up</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={!canWritePreferences || !options.canMoveDown}
                  onClick={() => handleMove(model.slug, 1)}
                  aria-label={`Move ${model.name} down`}
                />
              }
            >
              <ArrowDownIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move down</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {model.isCustom ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={!canManageCustomModels}
                  aria-label={`Edit ${model.slug}`}
                  onClick={() => {
                    if (!canManageCustomModels) return;
                    setEditingSlug((current) => (current === model.slug ? null : model.slug));
                  }}
                />
              }
            >
              <PencilIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Edit name and options</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-destructive"
                  disabled={!canManageCustomModels}
                  aria-label={`Remove ${model.slug}`}
                  onClick={() => void handleRemove(model.slug)}
                />
              }
            >
              <XIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Remove custom model</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </span>
  );

  const pickerTooltip = (model: DisplayModel, isHidden: boolean) =>
    model.isCustom
      ? "Custom models are always shown in the picker"
      : isHidden
        ? "Hidden from picker"
        : "Shown in picker";

  // The trigger is a wrapper span: a disabled switch gets no pointer events,
  // so it could not open the tooltip itself.
  const pickerSwitch = (model: DisplayModel, isHidden: boolean) => (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
        <Switch
          checked={!isHidden}
          disabled={!canWritePreferences || model.isCustom}
          onCheckedChange={(checked) => setHidden(model.slug, !checked)}
          aria-label={`Show ${model.name} in the model picker`}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{pickerTooltip(model, isHidden)}</TooltipPopup>
    </Tooltip>
  );

  const renderRow = (model: DisplayModel) => {
    const capLabels = describeModelCapabilities(model);
    const group = groupOf(model);
    const isHidden = group === "hidden";
    const index = displayModels.indexOf(model);
    const previousModel = displayModels[index - 1];
    const nextModel = displayModels[index + 1];
    // Reordering a filtered view would be ambiguous, so arrows only show on
    // the full list.
    const canMoveUp =
      !isFiltering && previousModel !== undefined && groupOf(previousModel) === group;
    const canMoveDown = !isFiltering && nextModel !== undefined && groupOf(nextModel) === group;
    const meta = [model.name !== model.slug ? model.slug : null, ...capLabels]
      .filter((part) => part !== null)
      .join(" · ");

    return (
      <SettingsDenseRow
        key={`${instanceId}:${model.slug}`}
        data-model-slug={model.slug}
        // A hidden model reads as off, like a disabled row.
        className={cn(isHidden && "opacity-50")}
        title={model.name}
        titleActions={model.isCustom ? <SettingsTag>Custom</SettingsTag> : null}
        meta={meta}
        control={
          <>
            {onEffortDefaultChange ? (
              <ModelEffortDefaultSelect
                model={model}
                configured={effortDefaults?.[model.slug]}
                disabled={!canWritePreferences}
                onChange={(option) => onEffortDefaultChange(model.slug, option)}
              />
            ) : null}
            {rowActions(model, { isHidden, canMoveUp, canMoveDown })}
            {pickerSwitch(model, isHidden)}
          </>
        }
      />
    );
  };

  const groupLabel = (label: string) => (
    <div
      className={cn(
        "border-t border-border/50 px-3 pt-3 pb-1.5 first:border-t-0 sm:px-4",
        SETTINGS_MICRO_LABEL_CLASSNAME,
      )}
    >
      {label}
    </div>
  );

  return (
    <SettingsSection
      title="Models"
      headerAction={
        canManageCustomModels ? (
          <SettingsSectionAction onClick={() => setIsAdding(true)}>
            Add custom model
          </SettingsSectionAction>
        ) : null
      }
      footer="Saved on this machine, so every device connected to it sees the same models."
    >
      {/* Text actions without padding, so the toolbar's ends sit on the rows' edges. */}
      <SettingsToolbar className="gap-x-3 text-xs text-muted-foreground">
        {showFilter ? (
          <SettingsListSearch
            label="Filter models"
            width="field"
            value={filter}
            onValueChange={setFilter}
          />
        ) : null}
        <span>
          {models.length} model{models.length === 1 ? "" : "s"}
          {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
        </span>
        {builtInModels.length > 0 ? (
          <InlineButton
            tone="muted"
            weight="normal"
            className="ml-auto"
            disabled={!canWritePreferences}
            onClick={() =>
              onHiddenModelsChange(
                nextHiddenModelsForBulkToggle(models, hiddenModels),
                builtInModels.map((model) => model.slug),
              )
            }
          >
            {allBuiltInModelsHidden ? "Show all in picker" : "Hide all from picker"}
          </InlineButton>
        ) : null}
      </SettingsToolbar>
      {/* Never a scroller of its own: the filter shortens a long list, and the
          page (or the detail pane) is the one thing that scrolls. */}
      <SettingsDenseList ref={listRef}>
        {visibleModels.length === 0 ? (
          <SettingsEmpty
            icon={isFiltering ? <SearchIcon /> : <SparklesIcon />}
            label={isFiltering ? "No models match." : "No models reported for this provider yet."}
          />
        ) : null}
        {visibleModels.map((model, index) => {
          const group = groupOf(model);
          const previous = visibleModels[index - 1];
          const startsGroup = previous === undefined || groupOf(previous) !== group;
          const editingEntry =
            canManageCustomModels && model.isCustom && editingSlug === model.slug
              ? customModels.find((entry) => entry.slug === model.slug)
              : undefined;
          return (
            <Fragment key={`${instanceId}:${model.slug}:group`}>
              {startsGroup && group === "hidden" ? groupLabel("Hidden from picker") : null}
              {renderRow(model)}
              {canManageCustomModels && model.isCustom ? (
                <DisclosurePanel open={editingEntry !== undefined}>
                  {editingEntry ? (
                    <CustomModelEditor
                      key={`${instanceId}:${model.slug}:editor`}
                      instanceId={instanceId}
                      driverKind={driverKind}
                      entry={editingEntry}
                      builtInModels={builtInModels}
                      onSave={handleSaveEdit}
                      onCancel={() => setEditingSlug(null)}
                    />
                  ) : null}
                </DisclosurePanel>
              ) : null}
            </Fragment>
          );
        })}
      </SettingsDenseList>

      {canManageCustomModels ? (
        <DisclosurePanel open={isAdding}>
          <div className="@container flex flex-col gap-2 px-3 py-3 sm:px-4">
            <div className="flex flex-col gap-2 @min-[24rem]:flex-row">
              <Input
                id={`provider-instance-${instanceId}-custom-model`}
                size="sm"
                autoFocus
                aria-label="Custom model slug"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelAdd();
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  handleAdd();
                }}
                placeholder={
                  driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"
                }
                spellCheck={false}
              />
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={handleAdd}>
                  Add
                </Button>
                <Button size="sm" variant="outline" onClick={cancelAdd}>
                  Cancel
                </Button>
              </div>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DisclosurePanel>
      ) : null}
    </SettingsSection>
  );
}

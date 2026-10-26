import {
  integrationSourceNotice,
  integrationSourceRowText,
  integrationSourcesForProject,
} from "@cogenly/client-runtime/composerThreadItems";
import type {
  EnvironmentId,
  IntegrationCatalogId,
  IntegrationSource,
  ProjectLabelId,
} from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlugIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { integrationsRpc } from "~/rpc/integrations";
import { useEnvironmentQuery } from "~/state/query";
import { INTEGRATION_LOGOS } from "../IntegrationLogos";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  SearchListEmpty,
  SearchListRowBadge,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowText,
  SearchListRowTrailing,
} from "../ui/search-list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { composerFloatingLayerProps, useComposerMenuProps } from "./composerEventScope";

const EMPTY_SOURCES: ReadonlyArray<IntegrationSource> = [];

/**
 * The environment's connected integrations, live: the server pushes the list
 * again after every change, including a sign-in finished elsewhere. Pass a
 * null environment to stay unsubscribed. `sources` is kept to the thread's
 * project, as the agent will see them.
 */
export function useComposerSources(
  environmentId: EnvironmentId | null,
  projectLabelId: ProjectLabelId | null,
) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.sources({ environmentId, input: {} }),
  );
  const all = query.data?.sources ?? EMPTY_SOURCES;
  const sources = useMemo(
    () => integrationSourcesForProject(all, projectLabelId),
    [all, projectLabelId],
  );
  return { all, sources, isLoaded: query.data !== null, error: query.error };
}

/** A service's brand mark, or a plug for a custom server. */
export function IntegrationSourceIcon(props: {
  icon: IntegrationCatalogId | null;
  className?: string;
}) {
  const Logo = props.icon === null ? null : INTEGRATION_LOGOS[props.icon];
  return Logo ? (
    <Logo className={props.className} />
  ) : (
    <PlugIcon aria-hidden="true" className={props.className} />
  );
}

/**
 * One source as a search-list row: brand mark, service, account, and a badge
 * when it needs attention. The Sources picker and the `@` menu both render it.
 */
export function IntegrationSourceRowContent(props: { source: IntegrationSource }) {
  const { label, description } = integrationSourceRowText(props.source);
  const notice = integrationSourceNotice(props.source);
  return (
    <>
      <SearchListRowIcon>
        <IntegrationSourceIcon icon={props.source.icon} className="size-4" />
      </SearchListRowIcon>
      <SearchListRowText layout="inline">
        <SearchListRowLabel>{label}</SearchListRowLabel>
        {description ? <SearchListRowDescription>{description}</SearchListRowDescription> : null}
      </SearchListRowText>
      {notice ? (
        <SearchListRowTrailing>
          <SearchListRowBadge tone={notice.tone}>{notice.badge}</SearchListRowBadge>
        </SearchListRowTrailing>
      ) : null}
    </>
  );
}

type SourceOption =
  | { readonly kind: "source"; readonly key: string; readonly source: IntegrationSource }
  | { readonly kind: "connect"; readonly key: "connect" };

function optionText(option: SourceOption): string {
  if (option.kind === "connect") return "Connect sources";
  const { label, description } = integrationSourceRowText(option.source);
  return description ? `${label} ${description}` : label;
}

/**
 * The composer toolbar's Sources control: a searchable list of the
 * integrations this thread's agent can use. Picking one hands it to
 * `onPick`, which inserts its chip at the caret; the last row opens Settings
 * → Integrations to connect more.
 *
 * `open` and `anchor` let the toolbar's overflow menu open it when the
 * button itself has folded away.
 */
export function ComposerSourcesPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectLabelId: ProjectLabelId | null;
  readonly size: ComposerControlSize;
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the popup sits when it was opened from somewhere other than its button. */
  readonly anchor?: Element | null;
  readonly onPick: (source: IntegrationSource) => void;
}) {
  const navigate = useNavigate();
  const menuProps = useComposerMenuProps();
  const [query, setQuery] = useState("");
  // A pick puts the caret after its new chip; only a dismissal hands focus back here.
  const pickedRef = useRef(false);
  const { sources, isLoaded, error } = useComposerSources(
    props.open ? props.environmentId : null,
    props.projectLabelId,
  );

  const options = useMemo((): SourceOption[] => {
    const needle = query.trim().toLowerCase();
    const matches = sources.filter(
      (source) =>
        needle === "" ||
        optionText({ kind: "source", key: source.id, source }).toLowerCase().includes(needle),
    );
    return [
      ...matches.map((source): SourceOption => ({ kind: "source", key: source.id, source })),
      { kind: "connect", key: "connect" },
    ];
  }, [query, sources]);
  const hasMatches = options.length > 1;

  const close = () => {
    props.onOpenChange(false);
    setQuery("");
  };

  const choose = (option: SourceOption) => {
    pickedRef.current = true;
    close();
    if (option.kind === "connect") {
      // Settings opens on this composer's environment, where the integrations live.
      void navigate({ to: "/settings/integrations", search: { machine: props.environmentId } });
      return;
    }
    props.onPick(option.source);
  };

  const emptyText =
    error !== null
      ? "Couldn't load sources."
      : !isLoaded
        ? "Loading sources…"
        : sources.length === 0
          ? "No sources connected yet."
          : "No matching source.";

  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={null}
      open={props.open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "item-press") return;
        if (next) pickedRef.current = false;
        props.onOpenChange(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={optionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (option) choose(option);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              disabled={props.disabled}
              aria-label="Sources"
              data-composer-sources-picker=""
              render={<ComposerControl size={props.size} className="min-w-0" />}
            />
          }
        >
          <ComposerControlIcon icon={PlugIcon} opticalWidth="narrow" size={props.size} />
          <span data-composer-control-label>Sources</span>
          <ComposerControlChevron size={props.size} />
        </TooltipTrigger>
        <TooltipPopup side="top">Add a source for the agent to use</TooltipPopup>
      </Tooltip>
      <ComboboxPopup
        align="start"
        {...(props.anchor ? { anchor: props.anchor } : {})}
        animateHeight
        className="w-72"
        {...composerFloatingLayerProps}
        finalFocus={() => (pickedRef.current ? false : (menuProps.finalFocus?.() ?? true))}
      >
        <ComboboxSearchInput
          aria-label="Find a source"
          placeholder="Find a source"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {hasMatches ? null : (
          // One row tall and on the rows' column, as the `@` menu says it, so the
          // popup keeps its height as sources load; the list's padding spaces it
          // from "Connect sources" below.
          <SearchListEmpty size="row" className="m-1.5 mb-0">
            {emptyText}
          </SearchListEmpty>
        )}
        <ComboboxList>
          {(option: SourceOption) => (
            <ComboboxItem
              key={option.key}
              value={option}
              hideIndicator
              tone={option.kind === "connect" ? "action" : "default"}
              // One hairline sets the action apart from the sources.
              divider={option.kind === "connect" && hasMatches}
            >
              {option.kind === "connect" ? (
                <>
                  <SearchListRowIcon>
                    <PlusIcon />
                  </SearchListRowIcon>
                  <SearchListRowText>
                    <SearchListRowLabel>Connect sources</SearchListRowLabel>
                  </SearchListRowText>
                </>
              ) : (
                <IntegrationSourceRowContent source={option.source} />
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

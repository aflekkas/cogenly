import {
  DEFAULT_SERVER_SETTINGS,
  isUniversalServerSettingKey,
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  resolveEnvironmentMachineKind,
  type ServerSettings,
} from "@cogenly/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { formatSettingValue } from "./settingValueLabels";
import { Button, InlineButton } from "../ui/button";
import { DisclosureChevron } from "../ui/disclosure";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import type { ProjectOverrideEntry, ScopedSettingsTarget } from "./scopedSettings";
import { isProjectScopedSettingKey } from "./scopedSettings";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

interface InheritanceLayer {
  readonly key: "project" | "environment" | "cogenly.json" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

/**
 * The layers a setting resolves through for one target, top-down: the
 * project override when the target is a project's repository, the value for
 * all projects (a machine-local key's is the machine's), the repository's
 * cogenly.json for file-backed keys, and the built-in default. The first
 * layer that is set wins. Same order as `resolveProjectSettings`.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  environmentSettings: ServerSettings,
  key: keyof ServerSettings,
  projectLabel = "This project",
): readonly InheritanceLayer[] {
  const environmentValue = environmentSettings[key];
  const source = isProjectScopedSettingKey(key) ? target.sources[key] : "environment";
  const environmentSet = !Equal.equals(environmentValue, DEFAULT_SERVER_SETTINGS[key]);
  const fileBacked = isProjectFileBackedSettingKey(key);
  const layers: InheritanceLayer[] = [];
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: projectLabel,
      value: source === "project" ? formatSettingValue(key, target.settings[key]) : "Inherits",
      effective: source === "project",
      set: source === "project",
    });
  }
  layers.push({
    key: "environment",
    label: isUniversalServerSettingKey(key) ? "All projects" : target.label,
    value: environmentSet ? formatSettingValue(key, environmentValue) : "Inherits",
    effective: source === "environment" && environmentSet,
    set: environmentSet,
  });
  if (fileBacked && target.projectId !== null) {
    layers.push({
      key: "cogenly.json",
      label: "cogenly.json",
      value: source === "cogenly.json" ? formatSettingValue(key, target.settings[key]) : "Inherits",
      effective: source === "cogenly.json",
      set: source === "cogenly.json",
    });
  }
  // For a file-backed key the built-in is what the resolver produced with
  // nothing set, not the null the schema decodes to.
  const builtIn = fileBacked
    ? PROJECT_FILE_BACKED_SETTINGS[key].builtIn
    : DEFAULT_SERVER_SETTINGS[key];
  layers.push({
    key: "built-in",
    label: "Default",
    value: formatSettingValue(key, builtIn),
    effective: source === "environment" && !environmentSet,
    set: true,
  });
  return layers;
}

function isProjectFileBackedSettingKey(
  key: keyof ServerSettings,
): key is ProjectFileBackedSettingKey {
  return Object.hasOwn(PROJECT_FILE_BACKED_SETTINGS, key);
}

export type SettingInheritanceState =
  | "default"
  | "environment"
  | "inherited"
  | "overridden"
  | "mixed";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from on each selected target. It sits inline so
 * narrowing to a project does not add a caption line to every row.
 */
export interface SettingOverridingProject {
  /** The project folder id, or a fixed id for repositories in no project. */
  readonly id: string;
  readonly label: string;
  /** The folder's repository entries holding the override, on every environment. */
  readonly entries: readonly ProjectOverrideEntry[];
  /** Selects this project so its override can be edited; absent where it cannot be. */
  readonly open?: (() => void) | undefined;
}

export function SettingInheritance({
  state,
  summary,
  targets,
  environments,
  keys,
  overridingProjects = [],
  onClearOverrides,
}: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environments: readonly Pick<
    EnvironmentPresentation,
    "environmentId" | "label" | "displayUrl" | "serverConfig"
  >[];
  keys: readonly (keyof ServerSettings)[];
  /** At All projects: projects whose own value replaces the one for all projects. */
  overridingProjects?: readonly SettingOverridingProject[];
  onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  const scopeContext = useOptionalSettingsScope();
  const key = keys[0];
  if (!key || targets.length === 0) return null;
  const hasMultipleEnvironments = new Set(targets.map((target) => target.environmentId)).size > 1;
  const projectLabel =
    scopeContext?.scope.kind === "project" ? scopeContext.scope.label : "This project";
  // A universal value is the same on every machine, so its chain names no machine.
  const showsMachine = !isUniversalServerSettingKey(key) || targets[0]?.projectId != null;
  const overrideSummary =
    overridingProjects.length > 0
      ? `${summary} · ${projectOverridesSummary(overridingProjects)}`
      : summary;
  const overrideValue = (project: SettingOverridingProject) => {
    if (!isProjectScopedSettingKey(key)) return null;
    for (const entry of project.entries) {
      const overrides = environments.find(
        (environment) => environment.environmentId === entry.environmentId,
      )?.serverConfig?.settings.projectSettingsOverrides;
      const entryOverrides = overrides?.[entry.projectId];
      if (entryOverrides && Object.hasOwn(entryOverrides, key)) {
        return formatSettingValue(key, entryOverrides[key]);
      }
    }
    return null;
  };
  const chains = targets.flatMap((target) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === target.environmentId,
    );
    if (!environment?.serverConfig) return [];
    const labels = settingsScopeEnvironmentLabels(environment, environments);
    const path = scopeContext?.scope.members.find(
      (member) => member.environmentId === target.environmentId && member.id === target.projectId,
    )?.workspaceRoot;
    const secondary = [labels.secondary, path?.split(/[\\/]/).filter(Boolean).slice(-2).join("/")]
      .filter(Boolean)
      .join(" · ");
    const layers = settingInheritanceLayers(
      target,
      environment.serverConfig.settings,
      key,
      projectLabel,
    );
    const winningLayer = layers.find((layer) => layer.effective);
    return [
      {
        id: `${target.environmentId}:${target.projectId ?? ""}`,
        target,
        label: [labels.primary, secondary].filter(Boolean).join(" · "),
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        layers,
        winningLayer,
        resolution: {
          winner: winningLayer?.key,
          layers: layers.map(({ key, value }) => [key, value]),
          settings: keys.map((settingKey) => target.settings[settingKey]),
        },
      },
    ];
  });
  const primary =
    chains.find(
      ({ target }) =>
        target.environmentId === scopeContext?.target?.environmentId &&
        target.projectId === scopeContext?.target?.projectId,
    ) ?? chains[0];
  const groups: (typeof chains)[] = [];
  for (const chain of hasMultipleEnvironments && primary
    ? [primary, ...chains.filter((entry) => entry !== primary)]
    : chains) {
    const group =
      hasMultipleEnvironments &&
      groups.find(([first]) => first && Equal.equals(first.resolution, chain.resolution));
    if (group) group.push(chain);
    else groups.push([chain]);
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${overrideSummary}. Show where this value comes from`}
                />
              }
            />
          }
        >
          <LayersIcon
            className={cn(
              "size-3",
              state === "overridden" && "text-primary",
              state === "mixed" && "text-warning",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{overrideSummary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <div className="divide-y divide-border/60">
          {groups.map((members) => {
            const first = members[0];
            if (!first) return null;
            const { id, machine, layers, winningLayer } = first;
            const chain = (
              <ol role="list" className="text-sm">
                {layers.map((layer) => (
                  <li
                    key={layer.key}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                      layer.effective && "bg-foreground/[0.06]",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {layer.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 tabular-nums",
                        layer.effective
                          ? "text-foreground"
                          : layer.set
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                      )}
                    >
                      <span className="max-w-32 truncate">{layer.value}</span>
                      {layer.effective ? (
                        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            );
            return (
              <section key={id} className="px-3 py-2.5">
                {!hasMultipleEnvironments && showsMachine ? (
                  <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={machine}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{first.label}</span>
                  </h4>
                ) : null}
                {hasMultipleEnvironments && groups.length > 1 ? (
                  <Collapsible>
                    <CollapsibleTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm-multiline"
                          className="w-full justify-start text-left"
                        />
                      }
                    >
                      <span className="flex w-full min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground tabular-nums">
                            {winningLayer?.value}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {winningLayer?.label}
                          </span>
                          <DisclosureChevron />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                          {members.map((member) => (
                            <span
                              key={member.id}
                              className="flex min-w-0 max-w-full items-center gap-1"
                            >
                              <EnvironmentMachineIcon
                                aria-hidden
                                kind={member.machine}
                                className="size-3 shrink-0"
                              />
                              <span className="truncate">{member.label}</span>
                            </span>
                          ))}
                        </span>
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="pt-1.5">{chain}</div>
                    </CollapsiblePanel>
                  </Collapsible>
                ) : (
                  <>
                    {chain}
                    {hasMultipleEnvironments ? (
                      <p className="px-2 pt-1.5 text-xs text-muted-foreground">
                        Same on all machines
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            );
          })}
          {overridingProjects.length > 0 ? (
            <ProjectOverridesList
              projects={overridingProjects}
              valueFor={overrideValue}
              {...(onClearOverrides ? { onClear: onClearOverrides } : {})}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** "N projects override this", for a tooltip or label. */
export function projectOverridesSummary(projects: readonly SettingOverridingProject[]) {
  return `${projects.length} ${projects.length === 1 ? "project overrides" : "projects override"} this`;
}

/**
 * The projects whose own value replaces the one being edited, each with its
 * value, and a reset that clears them on every machine holding them.
 */
function ProjectOverridesList({
  projects,
  valueFor,
  onClear,
}: {
  projects: readonly SettingOverridingProject[];
  valueFor: (project: SettingOverridingProject) => string | null;
  onClear?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  return (
    <section className="px-3 py-2.5">
      <Collapsible defaultOpen={projects.length <= 3}>
        <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
          {projects.length > 3 ? (
            <CollapsibleTrigger render={<InlineButton tone="muted" />}>
              <DisclosureChevron />
              Overridden by
            </CollapsibleTrigger>
          ) : (
            <span>Overridden by</span>
          )}
          {onClear ? (
            <InlineButton onClick={() => onClear(projects.flatMap((project) => project.entries))}>
              Reset {projects.length === 1 ? "it" : "all"}
            </InlineButton>
          ) : null}
        </div>
        <CollapsiblePanel>
          <ul role="list" className="scroll-fade-y mt-0.5 max-h-48 overflow-y-auto text-sm">
            {projects.map((project) => (
              <li
                key={project.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1"
              >
                {project.open ? (
                  <InlineButton className="min-w-0 max-w-full justify-start" onClick={project.open}>
                    <span className="truncate">{project.label}</span>
                  </InlineButton>
                ) : (
                  <span className="min-w-0 truncate">{project.label}</span>
                )}
                <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                  {valueFor(project)}
                </span>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

/**
 * The project overrides of a setting edited outside the settings rows (a
 * provider's switch, worktree cleanup on Storage): the same layers indicator,
 * opening only the list of overriding projects. Renders nothing without one.
 */
export function ProjectOverridesPopover({
  projects,
  valueFor,
  onClear,
}: {
  projects: readonly SettingOverridingProject[];
  valueFor: (project: SettingOverridingProject) => string | null;
  onClear?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  if (projects.length === 0) return null;
  const summary = projectOverridesSummary(projects);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${summary}. Show the projects`}
                />
              }
            />
          }
        >
          <LayersIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <ProjectOverridesList
          projects={projects}
          valueFor={valueFor}
          {...(onClear ? { onClear } : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}

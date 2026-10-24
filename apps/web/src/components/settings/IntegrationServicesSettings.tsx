import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  INTEGRATION_CATALOG,
  integrationCatalogEntry,
  type EnvironmentId,
  type Integration,
  type IntegrationCatalogAuthKind,
  type IntegrationCatalogEntry,
  type IntegrationCatalogId,
  type IntegrationConnectResult,
  type IntegrationId,
  type IntegrationSummary,
  type IntegrationTestResult,
  type ProjectLabelId,
  type ProjectLabelWithRepositories,
  type VaultItemMetadata,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  KeyRoundIcon,
  LogInIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  PowerIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import { cn } from "~/lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { ProjectLabelChips, ProjectLabelPicker } from "../../projectLabels/ProjectLabelPicker";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { integrationsRpc } from "../../rpc/integrations";
import { vaultRpc } from "../../rpc/vault";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { IntegrationSourceIcon } from "../chat/ComposerSourcesPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DisclosureChevron, DisclosurePanel } from "../ui/disclosure";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  SearchListEmpty,
  SearchListRowBadge,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowText,
  SearchListRowTrailing,
} from "../ui/search-list";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  accountCounts,
  accountLabelProblem,
  accountRowId,
  addAsksForAccountLabel,
  catalogErrorText,
  isGuidedSetup,
  orderAccounts,
  resolveSetupTarget,
  setupControl,
  type GuidedSetup,
  type SetupControl,
} from "./integrationCatalog.logic";
import {
  EMPTY_INTEGRATION_DRAFT,
  VAULT_FIELD_LABEL,
  credentialReference,
  draftChanges,
  draftFromIntegration,
  insertCredentialReference,
  integrationErrorText,
  integrationStatus,
  integrationTitle,
  referenceableVaultItems,
  rowsToHeaders,
  scopeLabel,
  signInAction,
  testResultReason,
  toolCountLabel,
  unresolvedCredentialReferences,
  updateInputFromDraft,
  urlHost,
  validateIntegrationDraft,
  withDisplayName,
  type IntegrationDraft,
  type IntegrationTest,
} from "./integrationServices.logic";
import { IntegrationSetupGuide, openSignInPage } from "./IntegrationSetupGuide";
import { useStatusFade } from "./integrationStatusMotion";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { scrollToSettingsTarget, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const EMPTY_SUMMARIES: ReadonlyArray<IntegrationSummary> = [];
const EMPTY_VAULT_ITEMS: ReadonlyArray<VaultItemMetadata> = [];
const READ_ONLY_MESSAGE = "This connection can't change integrations.";
const ADD_ROW_ID = searchableSetting("integration-add").id;

/** The value, or null after toasting a failure that was not a cancel. */
function settled<A, E>(title: string, result: AtomCommandResult<A, E>): A | null {
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    toastManager.add({
      type: "error",
      title,
      description: integrationErrorText(squashAtomCommandFailure(result)),
    });
  }
  return null;
}

/** Which editor is open: a catalog account's name and projects, or a custom server's full definition. */
type EditorTarget =
  | { readonly kind: "account"; readonly integration: Integration }
  | { readonly kind: "custom"; readonly integration: Integration | null };

/**
 * Settings → Integrations → Services: every connected account, one row each,
 * then Add for the core catalog or a custom MCP server. Anything an account
 * or a new service needs first (a sign-in, an app of your own, a key, uv) is
 * one guided step inline on its row. `setupTarget` is an agent's `?setup=`
 * link: an account or catalog id whose step opens once the list loads.
 * Follows the scope sentence's environment.
 */
export function IntegrationServicesSettings(props: {
  readonly setupTarget?: string | undefined;
  readonly onSetupHandled?: (() => void) | undefined;
}) {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.list({ environmentId, input: {} }),
  );
  const canWrite =
    useAtomValue(integrationsRpc.connectFromCatalog.permissionAtom(environmentId)) &&
    environmentId !== null;
  const canInstall = useAtomValue(integrationsRpc.installRuntime.permissionAtom(environmentId));
  const { labels } = useEnvironmentProjectLabels(environmentId);
  // Tests from this page; the list only knows tools an agent listed recently.
  const [tests, setTests] = useState<ReadonlyMap<IntegrationId, IntegrationTest>>(() => new Map());
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [adding, setAdding] = useState<IntegrationCatalogId | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<IntegrationId>>(() => new Set());
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [handledTarget, setHandledTarget] = useState<string | null>(null);
  const integrations = query.data?.integrations ?? EMPTY_SUMMARIES;
  const rows = orderAccounts(integrations);
  const counts = accountCounts(rows);

  // An agent's link opens its step once the list is here, then scrolls to it.
  const setupTarget = props.setupTarget ?? null;
  if (setupTarget === null && handledTarget !== null) setHandledTarget(null);
  if (setupTarget !== null && setupTarget !== handledTarget && query.data !== null) {
    setHandledTarget(setupTarget);
    const resolved = resolveSetupTarget(setupTarget, integrations);
    if (resolved?.kind === "account") {
      setExpanded((current) => new Set(current).add(resolved.id));
      setScrollTarget(accountRowId(resolved.id));
    } else if (resolved?.kind === "catalog" && canWrite) {
      setAdding(resolved.catalogId);
      setScrollTarget(ADD_ROW_ID);
    }
  }
  const onSetupHandled = props.onSetupHandled;
  useEffect(() => {
    if (setupTarget !== null && setupTarget === handledTarget) onSetupHandled?.();
  }, [handledTarget, onSetupHandled, setupTarget]);
  useEffect(() => {
    if (scrollTarget === null) return;
    // The row lays out with the list's first render; the next frame has its place.
    const frame = window.requestAnimationFrame(() => {
      scrollToSettingsTarget(scrollTarget);
      setScrollTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollTarget]);

  const recordTest = (integration: Integration, result: IntegrationTestResult) =>
    setTests((current) =>
      new Map(current).set(integration.id, { updatedAt: integration.updatedAt, result }),
    );
  const setRowExpanded = (id: IntegrationId, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <SettingsSection {...searchableSetting("integration-services")}>
        {environmentId === null ? (
          <SettingsRow title="Choose an environment to see its integrations." />
        ) : query.error !== null && query.data === null ? (
          <SettingsRow title="Couldn't load integrations" description={query.error} />
        ) : query.data === null ? (
          <SettingsRow title="Loading integrations…" role="status" />
        ) : (
          <>
            {rows.map(({ summary, entry }) => (
              <AccountRow
                key={summary.integration.id}
                environmentId={environmentId}
                summary={summary}
                entry={entry}
                labels={labels}
                canWrite={canWrite}
                canInstall={canInstall}
                lastTest={tests.get(summary.integration.id)}
                expanded={expanded.has(summary.integration.id)}
                onExpandedChange={(open) => setRowExpanded(summary.integration.id, open)}
                onTested={recordTest}
                onEdit={() =>
                  setEditor(
                    entry === undefined
                      ? { kind: "custom", integration: summary.integration }
                      : { kind: "account", integration: summary.integration },
                  )
                }
              />
            ))}
            <AddIntegrationRow
              environmentId={environmentId}
              counts={counts}
              empty={rows.length === 0}
              canWrite={canWrite}
              adding={adding}
              onAdd={setAdding}
              onAddCustom={() => {
                setAdding(null);
                setEditor({ kind: "custom", integration: null });
              }}
              onClose={() => setAdding(null)}
              onConnected={(id) => setRowExpanded(id, true)}
            />
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Provider connectors" hideTitle>
        <ProviderConnectorsSettingRow />
      </SettingsSection>
      <OverlayPresence when={editor !== null && environmentId !== null ? editor : null}>
        {(open) =>
          environmentId === null ? null : open.kind === "account" ? (
            <AccountEditorDialog
              environmentId={environmentId}
              integration={open.integration}
              labels={labels}
              onAdvanced={() => setEditor({ kind: "custom", integration: open.integration })}
              onClose={() => setEditor(null)}
            />
          ) : (
            <IntegrationEditorDialog
              environmentId={environmentId}
              integration={open.integration}
              labels={labels}
              onTested={recordTest}
              onClose={() => setEditor(null)}
            />
          )
        }
      </OverlayPresence>
    </>
  );
}

/**
 * Off by default: the catalog is the only route agents get to its services,
 * and Claude's and Codex's own connectors for them stay hidden.
 */
function ProviderConnectorsSettingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("provider-connectors")}
      description="Also give agents Claude's and Codex's own connectors for these services, such as claude.ai Gmail or ChatGPT's Slack app. Off keeps one copy of each service. Applies to new agent sessions."
      settingKeys={["useProviderConnectors"]}
      control={
        <ScopedSwitch
          settingKeys={["useProviderConnectors"]}
          checked={settings.useProviderConnectors}
          onCheckedChange={(checked) => updateSettings({ useProviderConnectors: Boolean(checked) })}
          aria-label="Use provider connectors too"
        />
      }
    />
  );
}

const STATUS_BADGE = {
  success: "success",
  error: "error",
  warning: "warning",
  neutral: "outline",
} as const;

/**
 * One account: its service and name, its status, and the one thing to do
 * when it isn't usable. One-click actions run from the row's button; a
 * setup with steps or a form opens under the row.
 */
function AccountRow(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: IntegrationSummary;
  /** The catalog service; none for a custom server. */
  readonly entry: IntegrationCatalogEntry | undefined;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly canWrite: boolean;
  readonly canInstall: boolean;
  readonly lastTest: IntegrationTest | undefined;
  readonly expanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly onTested: (integration: Integration, result: IntegrationTestResult) => void;
  readonly onEdit: () => void;
}) {
  const { environmentId, summary, entry } = props;
  const { integration } = summary;
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const remove = useOrchestrationCommand(integrationsRpc.remove, { reportFailure: false });
  const test = useOrchestrationCommand(integrationsRpc.testConnection, { reportFailure: false });
  const beginSignIn = useOrchestrationCommand(integrationsRpc.beginSignIn, {
    reportFailure: false,
  });
  const install = useAtomCommand(integrationsRpc.installRuntime, { reportFailure: false });
  const [busy, setBusy] = useState<SetupControl["kind"] | "remove" | null>(null);
  // Why Cogenly couldn't install the runtime; shown while that is still the step.
  const [installFailure, setInstallFailure] = useState<string | null>(null);
  const status = integrationStatus(summary, props.lastTest);
  const statusNode = useStatusFade<HTMLDivElement>(status.label);
  const setup = summary.setup;
  const control = setup === undefined ? null : setupControl(setup, props.canInstall);
  const guided = control?.kind === "expand" ? control.action : null;
  const title = integrationTitle(integration);
  const account = integration.accountLabel?.trim();
  const detail =
    (setup?.type === "install_runtime" ? installFailure : null) ??
    setup?.message ??
    status.reason ??
    [
      toolCountLabel(status.toolCount),
      entry === undefined ? urlHost(integration.url) : null,
      integration.scope.type === "all"
        ? null
        : `Only ${scopeLabel(integration.scope, props.labels)}`,
      summary.syncedFrom ? `From ${summary.syncedFrom.machineLabel}` : null,
      integration.provenance?.addedByAgent
        ? `Added by ${integration.provenance.addedByAgent.name}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const setEnabled = (enabled: boolean) =>
    run("enable", async () => {
      settled(
        `Couldn't ${enabled ? "enable" : "disable"} ${title}`,
        await update({ environmentId, input: { id: integration.id, enabled } }),
      );
    });
  const testNow = () =>
    run("test", async () => {
      const result = settled(
        `Couldn't test ${title}`,
        await test({ environmentId, input: { id: integration.id } }),
      );
      if (result === null) return;
      props.onTested(integration, result);
      toastManager.add(
        result.status === "connected"
          ? {
              type: "success",
              title: `${title} is connected`,
              description: toolCountLabel(result.toolCount) ?? undefined,
            }
          : {
              type: "error",
              title: `${title} couldn't connect`,
              description: testResultReason(result) ?? undefined,
            },
      );
    });
  // The row updates itself when the callback lands: the list is live.
  const signInNow = () =>
    run("sign_in", () =>
      openSignInPage(async () => {
        const started = settled(
          `Couldn't start sign-in to ${title}`,
          await beginSignIn({ environmentId, input: { id: integration.id } }),
        );
        return started?.authorizationUrl ?? null;
      }),
    );
  const installNow = () =>
    run("install", async () => {
      if (setup?.type !== "install_runtime") return;
      setInstallFailure(null);
      const result = settled(
        `Couldn't install ${setup.runtime}`,
        await install({ environmentId, input: { runtime: setup.runtime } }),
      );
      if (result === null) return;
      if (result.installed) toastManager.add({ type: "success", title: result.message });
      else setInstallFailure(result.message);
    });
  const removeNow = () =>
    run("remove", async () => {
      const message = `Remove “${title}”?\nAgents can no longer use it. Its sign-in is deleted; vault items it used stay in the vault.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
      settled(
        `Couldn't remove ${title}`,
        await remove({ environmentId, input: { id: integration.id } }),
      );
    });
  const runControl = (next: SetupControl) => {
    switch (next.kind) {
      case "sign_in":
        return void signInNow();
      case "test":
        return void testNow();
      case "edit":
        return props.onEdit();
      case "enable":
        return void setEnabled(true);
      case "install":
        return void installNow();
      case "expand":
        return props.onExpandedChange(!props.expanded);
    }
  };

  return (
    <SettingsRow
      id={accountRowId(integration.id)}
      className="pb-3"
      title={
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <IntegrationSourceIcon
            icon={entry?.icon ?? null}
            className={cn("size-4 shrink-0", entry === undefined && "text-muted-foreground")}
          />
          <span>{entry?.name ?? integration.displayName}</span>
          {account ? <span className="font-normal text-muted-foreground">{account}</span> : null}
        </span>
      }
      description={detail === "" ? undefined : detail}
      control={
        <>
          <div ref={statusNode} className="flex">
            <Badge size="sm" variant={STATUS_BADGE[status.tone]}>
              {status.label}
            </Badge>
          </div>
          {control === null ? null : (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={control.kind === "expand" ? props.expanded : undefined}
              disabled={control.kind !== "expand" && (!props.canWrite || busy !== null)}
              onClick={() => runControl(control)}
            >
              {busy === control.kind ? <Spinner /> : null}
              {control.label}
              {control.kind === "expand" ? <DisclosureChevron open={props.expanded} /> : null}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={!props.canWrite || busy !== null}
                  aria-label={`Actions for ${title}`}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {signInAction(summary) === "Reconnect" ? (
                <MenuItem disabled={!integration.enabled} onClick={() => void signInNow()}>
                  <LogInIcon />
                  Sign in again
                </MenuItem>
              ) : null}
              <MenuItem disabled={!integration.enabled} onClick={() => void testNow()}>
                <PlugZapIcon />
                Test connection
              </MenuItem>
              <MenuItem onClick={props.onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem onClick={() => void setEnabled(!integration.enabled)}>
                <PowerIcon />
                {integration.enabled ? "Disable" : "Enable"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void removeNow()}>
                <Trash2Icon />
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      <DisclosurePanel open={props.expanded && guided !== null}>
        {guided === null ? null : (
          <div className="pt-3">
            <IntegrationSetupGuide
              environmentId={environmentId}
              action={guided}
              target={
                guided.type === "install_runtime" || guided.catalogId === undefined
                  ? undefined
                  : { catalogId: guided.catalogId, integrationId: integration.id }
              }
              disabled={!props.canWrite}
              onTest={() => void testNow()}
            />
          </div>
        )}
      </DisclosurePanel>
    </SettingsRow>
  );
}

/**
 * The last row: Add, listing the core catalog and a custom MCP server. A
 * catalog choice opens its first step under the row; a custom server opens
 * its editor.
 */
function AddIntegrationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly counts: ReadonlyMap<IntegrationCatalogId, number>;
  readonly empty: boolean;
  readonly canWrite: boolean;
  readonly adding: IntegrationCatalogId | null;
  readonly onAdd: (id: IntegrationCatalogId) => void;
  readonly onAddCustom: () => void;
  readonly onClose: () => void;
  readonly onConnected: (id: IntegrationId) => void;
}) {
  const entry = props.adding === null ? undefined : integrationCatalogEntry(props.adding);
  return (
    <SettingsRow
      {...searchableSetting("integration-add")}
      className="pb-3"
      description={
        !props.canWrite
          ? READ_ONLY_MESSAGE
          : props.empty
            ? "Nothing connected yet. Connect a service once and every agent can use it, on Claude and Codex."
            : "Another service or account, or any remote MCP server."
      }
      control={
        <AddIntegrationPicker
          counts={props.counts}
          disabled={!props.canWrite}
          onAdd={props.onAdd}
          onAddCustom={props.onAddCustom}
        />
      }
    >
      <DisclosurePanel open={entry !== undefined}>
        {entry === undefined ? null : (
          <AddIntegrationPanel
            key={entry.id}
            environmentId={props.environmentId}
            entry={entry}
            existingAccounts={props.counts.get(entry.id) ?? 0}
            canWrite={props.canWrite}
            onClose={props.onClose}
            onConnected={props.onConnected}
          />
        )}
      </DisclosurePanel>
    </SettingsRow>
  );
}

type AddOption =
  | {
      readonly kind: "catalog";
      readonly key: IntegrationCatalogId;
      readonly entry: IntegrationCatalogEntry;
      readonly accounts: number;
    }
  | { readonly kind: "custom"; readonly key: "custom" };

function addOptionText(option: AddOption): string {
  return option.kind === "custom"
    ? "Custom MCP server"
    : `${option.entry.name} ${option.entry.description}`;
}

/** The shared searchable list, as the composer's Sources picker draws it. */
function AddIntegrationPicker(props: {
  readonly counts: ReadonlyMap<IntegrationCatalogId, number>;
  readonly disabled: boolean;
  readonly onAdd: (id: IntegrationCatalogId) => void;
  readonly onAddCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // A pick moves focus into the step it opens; only a dismissal hands it back here.
  const pickedRef = useRef(false);
  const options: AddOption[] = [
    ...INTEGRATION_CATALOG.map((entry): AddOption => ({
      kind: "catalog",
      key: entry.id,
      entry,
      accounts: props.counts.get(entry.id) ?? 0,
    })),
    { kind: "custom", key: "custom" },
  ];
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? options
      : options.filter((option) => addOptionText(option).toLowerCase().includes(needle));

  return (
    <Combobox
      items={options}
      filteredItems={filtered}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "item-press") return;
        if (next) pickedRef.current = false;
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={addOptionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (!option) return;
        pickedRef.current = true;
        setOpen(false);
        setQuery("");
        if (option.kind === "custom") props.onAddCustom();
        else props.onAdd(option.entry.id);
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled}
        aria-label="Add an integration"
        render={<Button size="sm" variant="outline" />}
      >
        <PlusIcon />
        Add
      </ComboboxTrigger>
      <ComboboxPopup
        align="end"
        animateHeight
        className="w-80"
        finalFocus={() => !pickedRef.current}
      >
        <ComboboxSearchInput
          aria-label="Find a service"
          placeholder="Find a service"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {filtered.length === 0 ? (
          <SearchListEmpty size="popover">No matching service.</SearchListEmpty>
        ) : null}
        <ComboboxList>
          {(option: AddOption) => (
            <ComboboxItem
              key={option.key}
              value={option}
              hideIndicator
              tone={option.kind === "custom" ? "action" : "default"}
              // One hairline sets the custom server apart from the catalog.
              divider={option.kind === "custom" && filtered.length > 1}
            >
              {option.kind === "custom" ? (
                <>
                  <SearchListRowIcon>
                    <BlocksIcon />
                  </SearchListRowIcon>
                  <SearchListRowText>
                    <SearchListRowLabel>Custom MCP server</SearchListRowLabel>
                  </SearchListRowText>
                </>
              ) : (
                <>
                  <SearchListRowIcon>
                    <IntegrationSourceIcon icon={option.entry.icon} className="size-4" />
                  </SearchListRowIcon>
                  <SearchListRowText>
                    <SearchListRowLabel>{option.entry.name}</SearchListRowLabel>
                    <SearchListRowDescription>{option.entry.description}</SearchListRowDescription>
                  </SearchListRowText>
                  {option.accounts > 0 ? (
                    <SearchListRowTrailing>
                      <SearchListRowBadge>
                        {option.accounts === 1 ? "Connected" : `${option.accounts} accounts`}
                      </SearchListRowBadge>
                    </SearchListRowTrailing>
                  ) : null}
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/**
 * Adding one catalog service: its name when it needs one, how to connect
 * when it offers more than one way, then the first step. Services that sign
 * in do so with one button; a key or an app of your own shows the server's
 * guided step before any account exists. Once the account exists, its row
 * takes over.
 */
function AddIntegrationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: IntegrationCatalogEntry;
  readonly existingAccounts: number;
  readonly canWrite: boolean;
  readonly onClose: () => void;
  /** The new account's row opens any step it still needs. */
  readonly onConnected: (id: IntegrationId) => void;
}) {
  const { environmentId, entry } = props;
  const connect = useOrchestrationCommand(integrationsRpc.connectFromCatalog, {
    reportFailure: false,
  });
  const id = useId();
  const modes = entry.kind === "remote" && entry.auth.length > 1 ? entry.auth : null;
  const [mode, setMode] = useState<IntegrationCatalogAuthKind | null>(
    entry.kind === "remote" ? entry.auth[0].kind : null,
  );
  const [accountLabel, setAccountLabel] = useState("");
  const [setup, setSetup] = useState<GuidedSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest mode's steps land, however the requests finish.
  const request = useRef(0);
  const asksLabel = addAsksForAccountLabel(entry, props.existingAccounts);
  const validate = () => accountLabelProblem(entry, props.existingAccounts, accountLabel);

  /** Closes once the account exists or nothing more is needed; otherwise shows what comes first. */
  const handle = (result: IntegrationConnectResult): string | null => {
    if (result.integration === undefined && result.setup !== undefined) {
      if (isGuidedSetup(result.setup)) setSetup(result.setup);
      else setError(result.setup.message);
      return null;
    }
    if (result.integration !== undefined) props.onConnected(result.integration.id);
    props.onClose();
    return result.signIn?.authorizationUrl ?? null;
  };

  /** A key or your own app: the server's steps, with this Cogenly's redirect address. */
  const loadSetup = async (next: IntegrationCatalogAuthKind | null) => {
    const ticket = ++request.current;
    setSetup(null);
    setError(null);
    if (next !== "api_key" && next !== "oauth_app") {
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await connect({
      environmentId,
      input: { catalogId: entry.id, inputs: { auth: next } },
    });
    if (ticket !== request.current) return;
    setLoading(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result))
        setError(catalogErrorText(squashAtomCommandFailure(result)));
      return;
    }
    handle(result.value);
  };
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadSetup(mode);
  });

  const connectNow = async () => {
    const problem = validate();
    if (problem !== null) {
      setError(problem);
      return;
    }
    const label = accountLabel.trim();
    setError(null);
    setPending(true);
    try {
      await openSignInPage(async () => {
        const result = await connect({
          environmentId,
          input: {
            catalogId: entry.id,
            ...(label === "" ? {} : { accountLabel: label }),
            ...(mode === null ? {} : { inputs: { auth: mode } }),
          },
        });
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result))
            setError(catalogErrorText(squashAtomCommandFailure(result)));
          return null;
        }
        return handle(result.value);
      });
    } finally {
      setPending(false);
    }
  };

  const signsIn = setup === null && !loading && (entry.kind === "local-preset" || mode === "oauth");

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-start gap-2.5">
        <IntegrationSourceIcon icon={entry.icon} className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">
            {props.existingAccounts > 0
              ? `Add another ${entry.name} account`
              : `Connect ${entry.name}`}
          </h4>
          <p className="text-xs leading-normal text-muted-foreground/80">{entry.description}</p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Cancel adding ${entry.name}`}
          disabled={pending}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {asksLabel || modes !== null ? (
        <div className="grid gap-3 @min-[32rem]/settings-row:grid-cols-2">
          {asksLabel ? (
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`${id}-account`}>Account name</Label>
              <Input
                id={`${id}-account`}
                autoFocus
                value={accountLabel}
                maxLength={80}
                disabled={pending}
                placeholder={entry.kind === "local-preset" ? "personal" : "Work"}
                onChange={(event) => {
                  setAccountLabel(event.currentTarget.value);
                  setError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Tells accounts apart, for you and for agents.
              </p>
            </div>
          ) : null}
          {modes !== null ? (
            <div className="min-w-0 space-y-1">
              <Label id={`${id}-mode`}>Connect with</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  const next = modes.find((candidate) => candidate.kind === value);
                  if (next === undefined || next.kind === mode) return;
                  setMode(next.kind);
                  void loadSetup(next.kind);
                }}
              >
                <SelectTrigger className="w-full" aria-labelledby={`${id}-mode`}>
                  <SelectValue>
                    {modes.find((candidate) => candidate.kind === mode)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {modes.map((candidate) => (
                    <SelectItem key={candidate.kind} value={candidate.kind}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
      <AnimatedHeight>
        {setup !== null ? (
          <IntegrationSetupGuide
            environmentId={environmentId}
            action={setup}
            target={{ catalogId: entry.id, accountLabel }}
            showMessage
            disabled={!props.canWrite}
            validate={validate}
            onSaved={handle}
          />
        ) : loading ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            Getting the steps…
          </p>
        ) : signsIn ? (
          <Button
            size="xs"
            autoFocus={!asksLabel}
            disabled={pending || !props.canWrite}
            onClick={() => void connectNow()}
          >
            {pending ? <Spinner /> : <LogInIcon />}
            {entry.kind === "local-preset" ? "Continue" : `Sign in to ${entry.name}`}
          </Button>
        ) : null}
      </AnimatedHeight>
      <AnimatedHeight>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </AnimatedHeight>
    </div>
  );
}

interface ScopeDraft {
  readonly scope: "all" | "projects";
  readonly labelIds: ReadonlyArray<ProjectLabelId>;
}

/** All projects, or the chosen project folders; both editors use it. */
function ScopeField(props: {
  readonly value: ScopeDraft;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly onChange: (next: ScopeDraft) => void;
}) {
  const id = useId();
  const { value } = props;
  return (
    <div className="space-y-1.5">
      <Label id={`${id}-scope`}>Available in</Label>
      <Select
        value={value.scope}
        onValueChange={(scope) => {
          if (scope === "all" || scope === "projects") props.onChange({ ...value, scope });
        }}
      >
        <SelectTrigger size="sm" className="w-full sm:w-48" aria-labelledby={`${id}-scope`}>
          <SelectValue>{value.scope === "all" ? "All projects" : "Chosen projects"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="all">All projects</SelectItem>
          <SelectItem value="projects">Chosen projects</SelectItem>
        </SelectPopup>
      </Select>
      <AnimatedHeight>
        {value.scope === "projects" ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <ProjectLabelChips labels={props.labels} ids={value.labelIds} />
            <ProjectLabelPicker
              labels={props.labels}
              selectedIds={value.labelIds}
              onToggle={(labelId, selected) =>
                props.onChange({
                  ...value,
                  labelIds: selected
                    ? [...value.labelIds, labelId]
                    : value.labelIds.filter((other) => other !== labelId),
                })
              }
            />
          </div>
        ) : null}
      </AnimatedHeight>
    </div>
  );
}

/**
 * A catalog account's name and projects. Its address and sign-in come from
 * the catalog; Advanced opens the full definition (headers such as
 * GitHub's `X-MCP-Toolsets`). Google accounts run locally and have none.
 */
function AccountEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly integration: Integration;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly onAdvanced: () => void;
  readonly onClose: () => void;
}) {
  const { integration } = props;
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const id = useId();
  const [accountLabel, setAccountLabel] = useState(integration.accountLabel ?? "");
  const [scope, setScope] = useState<ScopeDraft>(() => ({
    scope: integration.scope.type,
    labelIds: integration.scope.type === "projects" ? integration.scope.labelIds : [],
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const label = accountLabel.trim();
    if (integration.transport === "local" && label === "") {
      setError("Name this Google account, like personal or work.");
      return;
    }
    if (scope.scope === "projects" && scope.labelIds.length === 0) {
      setError("Choose at least one project, or make it available everywhere.");
      return;
    }
    setPending(true);
    try {
      const result = await update({
        environmentId: props.environmentId,
        input: {
          id: integration.id,
          accountLabel: label,
          scope:
            scope.scope === "all"
              ? { type: "all" }
              : { type: "projects", labelIds: [...scope.labelIds] },
        },
      });
      if (result._tag === "Success") {
        props.onClose();
        return;
      }
      if (!isAtomCommandInterrupted(result))
        setError(integrationErrorText(squashAtomCommandFailure(result)));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {integrationTitle(integration)}</DialogTitle>
          <DialogDescription>
            How you and agents tell it apart, and where it's available.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={`${id}-form`}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={pending} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-account`}>Account name</Label>
                <Input
                  id={`${id}-account`}
                  autoFocus
                  value={accountLabel}
                  maxLength={80}
                  placeholder="Work"
                  onChange={(event) => {
                    setAccountLabel(event.currentTarget.value);
                    setError(null);
                  }}
                />
              </div>
              <ScopeField
                value={scope}
                labels={props.labels}
                onChange={(next) => {
                  setScope(next);
                  setError(null);
                }}
              />
              <AnimatedHeight>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </AnimatedHeight>
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          {integration.transport === "local" ? null : (
            <Button
              type="button"
              variant="ghost"
              className="me-auto"
              disabled={pending}
              onClick={props.onAdvanced}
            >
              Advanced
            </Button>
          )}
          <DialogClose render={<Button variant="ghost" />} disabled={pending}>
            Cancel
          </DialogClose>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Add or edit a custom MCP server, with a connection test against what was saved. */
function IntegrationEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly integration: Integration | null;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly onTested: (integration: Integration, result: IntegrationTestResult) => void;
  readonly onClose: () => void;
}) {
  const { environmentId } = props;
  const create = useOrchestrationCommand(integrationsRpc.create, { reportFailure: false });
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const test = useOrchestrationCommand(integrationsRpc.testConnection, { reportFailure: false });
  const beginSignIn = useOrchestrationCommand(integrationsRpc.beginSignIn, {
    reportFailure: false,
  });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const callbackUrl =
    httpBaseUrl === null ? null : new URL("/oauth/integrations/callback", httpBaseUrl).href;
  const vault = useEnvironmentQuery(vaultRpc.list({ environmentId, input: {} }));
  const vaultItems = vault.data?.items ?? EMPTY_VAULT_ITEMS;
  const vaultLoading = vault.data === null && vault.error === null;
  // Becomes the created integration after a first save, so a test then edits it.
  const [stored, setStored] = useState(props.integration);
  const [draft, setDraft] = useState<IntegrationDraft>(() =>
    props.integration ? draftFromIntegration(props.integration) : EMPTY_INTEGRATION_DRAFT,
  );
  const [pending, setPending] = useState<"save" | "test" | "sign-in" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const edit = (next: Partial<IntegrationDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };
  const headers = rowsToHeaders(draft.headers);
  const unresolved =
    "headers" in headers && vault.data !== null
      ? unresolvedCredentialReferences(headers.headers, vaultItems)
      : [];

  /** Saves the draft when it differs from what is stored; null after reporting why not. */
  const persist = async (): Promise<Integration | null> => {
    const valid = validateIntegrationDraft(draft);
    if ("error" in valid) {
      setError(valid.error);
      return null;
    }
    if (stored === null) {
      const created = settled(
        "Couldn't add the integration",
        await create({ environmentId, input: { ...valid.fields, enabled: true } }),
      );
      if (created) setStored(created.integration);
      return created?.integration ?? null;
    }
    if (!draftChanges(stored, valid.fields)) return stored;
    const updated = settled(
      "Couldn't save the integration",
      await update({ environmentId, input: updateInputFromDraft(stored, valid.fields) }),
    );
    if (updated) setStored(updated.integration);
    return updated?.integration ?? null;
  };
  const save = async () => {
    setPending("save");
    try {
      if (await persist()) props.onClose();
    } finally {
      setPending(null);
    }
  };
  const testConnection = async () => {
    setPending("test");
    setTestResult(null);
    try {
      const integration = await persist();
      if (!integration) return;
      const result = settled(
        "Couldn't test the integration",
        await test({ environmentId, input: { id: integration.id } }),
      );
      if (result === null) return;
      setTestResult(result);
      props.onTested(integration, result);
    } finally {
      setPending(null);
    }
  };
  /** Saves, then opens the service's sign-in page; the row turns connected when it lands. */
  const signIn = async () => {
    setPending("sign-in");
    try {
      await openSignInPage(async () => {
        const integration = await persist();
        if (!integration) return null;
        const started = settled(
          "Couldn't start sign-in",
          await beginSignIn({ environmentId, input: { id: integration.id } }),
        );
        return started?.authorizationUrl ?? null;
      });
    } finally {
      setPending(null);
    }
  };
  const setHeader = (index: number, next: Partial<{ key: string; value: string }>) =>
    edit({
      headers: draft.headers.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...next } : row,
      ),
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && pending === null) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.integration
              ? `Edit ${integrationTitle(props.integration)}`
              : "Add a custom MCP server"}
          </DialogTitle>
          <DialogDescription>
            A remote MCP server every agent can use through Cogenly.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="integration-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={pending !== null} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="integration-display-name">Display name</Label>
                  <Input
                    id="integration-display-name"
                    autoFocus
                    value={draft.displayName}
                    maxLength={200}
                    placeholder="Tracker"
                    onChange={(event) => {
                      const displayName = event.currentTarget.value;
                      setDraft((current) => withDisplayName(current, displayName));
                      setError(null);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="integration-name">Name</Label>
                  <Input
                    id="integration-name"
                    value={draft.name}
                    maxLength={64}
                    placeholder="tracker"
                    // The name is how agents call it, so it is fixed once saved.
                    disabled={stored !== null}
                    onChange={(event) =>
                      edit({ name: event.currentTarget.value, nameEdited: true })
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="integration-url">Server URL</Label>
                <Input
                  id="integration-url"
                  type="url"
                  value={draft.url}
                  maxLength={2000}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => edit({ url: event.currentTarget.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="integration-account">Account (optional)</Label>
                <Input
                  id="integration-account"
                  value={draft.accountLabel}
                  maxLength={200}
                  placeholder="Work"
                  onChange={(event) => edit({ accountLabel: event.currentTarget.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Tells two connections to one service apart, like two workspaces.
                </p>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="integration-oauth">Sign in with OAuth</Label>
                  <Switch
                    id="integration-oauth"
                    checked={draft.oauth}
                    onCheckedChange={(checked) => edit({ oauth: Boolean(checked) })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Most hosted servers use this. You sign in once in your browser; agents keep access
                  after that.
                </p>
                <AnimatedHeight>
                  {draft.oauth ? (
                    <div className="space-y-2 pt-1">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          aria-label="Client ID"
                          value={draft.clientId}
                          maxLength={500}
                          placeholder="Client ID"
                          onChange={(event) => edit({ clientId: event.currentTarget.value })}
                        />
                        <div className="flex items-center gap-2">
                          <Input
                            className="min-w-0 flex-1"
                            aria-label="Client secret"
                            value={draft.clientSecret}
                            maxLength={500}
                            placeholder="Client secret from the vault"
                            onChange={(event) => edit({ clientSecret: event.currentTarget.value })}
                          />
                          <VaultReferenceMenu
                            items={vaultItems}
                            loading={vaultLoading}
                            onPick={(reference) => edit({ clientSecret: reference })}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Only for servers that need an app of your own: create one there
                        {callbackUrl ? `, add ${callbackUrl} as its redirect address,` : ""} and
                        enter its client ID and the vault item holding its secret.
                      </p>
                    </div>
                  ) : null}
                </AnimatedHeight>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Headers</div>
                <div className="space-y-2">
                  {draft.headers.map((row, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- rows have no identity beyond position
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        className="w-36 shrink-0"
                        aria-label="Header name"
                        value={row.key}
                        maxLength={200}
                        placeholder="Authorization"
                        onChange={(event) => setHeader(index, { key: event.currentTarget.value })}
                      />
                      <Input
                        className="min-w-0 flex-1"
                        aria-label={`${row.key || "Header"} value`}
                        value={row.value}
                        maxLength={4000}
                        placeholder="Bearer {{credential:item.password}}"
                        onChange={(event) => setHeader(index, { value: event.currentTarget.value })}
                      />
                      <VaultReferenceMenu
                        items={vaultItems}
                        loading={vaultLoading}
                        onPick={(reference) =>
                          setHeader(index, {
                            value: insertCredentialReference(row.value, reference),
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Remove ${row.key || "header"}`}
                        onClick={() =>
                          edit({
                            headers: draft.headers.filter((_, rowIndex) => rowIndex !== index),
                          })
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => edit({ headers: [...draft.headers, { key: "", value: "" }] })}
                >
                  <PlusIcon className="size-3" />
                  Add header
                </Button>
                <p className="text-xs text-muted-foreground">
                  Keep secrets in the vault and reference them here; the server fills them in at
                  call time.
                </p>
                <AnimatedHeight>
                  {unresolved.length > 0 ? (
                    <p className="text-xs text-destructive">
                      No vault item matches{" "}
                      {unresolved
                        .map((ref) => (ref.field ? `${ref.item}.${ref.field}` : ref.item))
                        .join(", ")}
                      .
                    </p>
                  ) : null}
                </AnimatedHeight>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="integration-hint">Hint for agents (optional)</Label>
                <Input
                  id="integration-hint"
                  value={draft.hint}
                  maxLength={500}
                  placeholder="Work inbox"
                  onChange={(event) => edit({ hint: event.currentTarget.value })}
                />
              </div>
              <ScopeField
                value={{ scope: draft.scope, labelIds: draft.labelIds }}
                labels={props.labels}
                onChange={(next) => edit({ scope: next.scope, labelIds: next.labelIds })}
              />
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {draft.oauth ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={stored !== null && !stored.enabled}
                      onClick={() => void signIn()}
                    >
                      <LogInIcon />
                      {pending === "sign-in" ? "Opening…" : "Sign in"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={stored !== null && !stored.enabled}
                    onClick={() => void testConnection()}
                  >
                    <PlugZapIcon />
                    {pending === "test" ? "Testing…" : "Test connection"}
                  </Button>
                  {stored === null ? (
                    <span className="text-xs text-muted-foreground">
                      {draft.oauth ? "Either adds" : "Testing adds"} the integration first.
                    </span>
                  ) : !stored.enabled ? (
                    <span className="text-xs text-muted-foreground">
                      Enable the integration to test it.
                    </span>
                  ) : null}
                </div>
                <AnimatedHeight>
                  {testResult ? (
                    <p
                      role="status"
                      className={
                        testResult.status === "connected"
                          ? "text-xs text-success-foreground"
                          : "text-xs text-destructive"
                      }
                    >
                      {testResult.status === "connected"
                        ? `Connected · ${toolCountLabel(testResult.toolCount)}`
                        : testResultReason(testResult)}
                    </p>
                  ) : null}
                </AnimatedHeight>
              </div>
              <AnimatedHeight>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </AnimatedHeight>
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />} disabled={pending !== null}>
            {stored !== null && props.integration === null ? "Done" : "Cancel"}
          </DialogClose>
          <Button type="submit" form="integration-editor" disabled={pending !== null}>
            {pending === "save" ? "Saving…" : stored !== null ? "Save" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Inserts `{{credential:<item>.<field>}}` for a vault item the user picks. */
function VaultReferenceMenu(props: {
  readonly items: ReadonlyArray<VaultItemMetadata>;
  readonly loading: boolean;
  readonly onPick: (reference: string) => void;
}) {
  const items = referenceableVaultItems(props.items);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Use a vault item"
            title="Use a vault item"
          />
        }
      >
        <KeyRoundIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Use a vault item</MenuGroupLabel>
          {props.loading ? (
            <MenuItem disabled>Loading vault…</MenuItem>
          ) : items.length === 0 ? (
            <MenuItem disabled>No vault items yet</MenuItem>
          ) : (
            items.map((item) => (
              <MenuSub key={item.id}>
                <MenuSubTrigger>{item.name}</MenuSubTrigger>
                <MenuSubPopup>
                  {item.fields.map((field) => (
                    <MenuItem
                      key={field}
                      onClick={() => props.onPick(credentialReference(item.name, field))}
                    >
                      {VAULT_FIELD_LABEL[field]}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  Integration,
  IntegrationId,
  IntegrationSummary,
  IntegrationTestResult,
  ProjectLabelWithRepositories,
  VaultItemMetadata,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  KeyRoundIcon,
  LogInIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import { requestConfirmDialog } from "../../confirmDialog";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectLabelChips, ProjectLabelPicker } from "../../projectLabels/ProjectLabelPicker";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { integrationsRpc } from "../../rpc/integrations";
import { vaultRpc } from "../../rpc/vault";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
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
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_SUMMARIES: ReadonlyArray<IntegrationSummary> = [];
const EMPTY_VAULT_ITEMS: ReadonlyArray<VaultItemMetadata> = [];
const READ_ONLY_MESSAGE = "This connection cannot change integrations.";

/**
 * Opens the service's sign-in page from a click. A web browser blocks a tab
 * opened after an await, so the tab opens first and follows the link once the
 * server returns it; the desktop app hands the link to the system browser.
 */
async function openSignInPage(link: () => Promise<string | null>) {
  const tab = window.desktopBridge ? null : window.open("", "_blank");
  const url = await link();
  if (url === null) {
    tab?.close();
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
    return;
  }
  await ensureLocalApi().shell.openExternal(url);
}

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

/**
 * Settings → Integrations → Services: remote MCP servers every agent reaches
 * through Cogenly, on every provider. Follows the scope sentence's environment.
 */
export function IntegrationServicesSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : integrationsRpc.list({ environmentId, input: {} }),
  );
  const canWrite =
    useAtomValue(integrationsRpc.create.permissionAtom(environmentId)) && environmentId !== null;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  // Tests from this page; the list only knows tools an agent listed recently.
  const [tests, setTests] = useState<ReadonlyMap<IntegrationId, IntegrationTest>>(() => new Map());
  const [editor, setEditor] = useState<{ readonly integration: Integration | null } | null>(null);
  const recordTest = (integration: Integration, result: IntegrationTestResult) =>
    setTests((current) =>
      new Map(current).set(integration.id, { updatedAt: integration.updatedAt, result }),
    );
  const integrations = query.data?.integrations ?? EMPTY_SUMMARIES;
  const add = () => setEditor({ integration: null });

  return (
    <SettingsSection
      {...searchableSetting("integration-services")}
      headerAction={
        integrations.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canWrite}
            title={canWrite ? undefined : READ_ONLY_MESSAGE}
            onClick={add}
          >
            <PlusIcon className="size-3" />
            Add integration
          </Button>
        ) : null
      }
    >
      {environmentId === null ? (
        <SettingsRow title="Choose an environment to see its integrations." />
      ) : query.error !== null ? (
        <SettingsRow title="Could not load integrations" description={query.error} />
      ) : query.data === null ? (
        <SettingsRow title="Loading integrations…" role="status" />
      ) : integrations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <BlocksIcon />
            </EmptyMedia>
            <EmptyTitle>No integrations yet</EmptyTitle>
            <EmptyDescription>
              Connect remote MCP servers once; every agent can use them, on Claude, Codex and Muse.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              disabled={!canWrite}
              title={canWrite ? undefined : READ_ONLY_MESSAGE}
              onClick={add}
            >
              <PlusIcon />
              Add integration
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        integrations.map((summary) => (
          <IntegrationRow
            key={summary.integration.id}
            environmentId={environmentId}
            summary={summary}
            labels={labels}
            canWrite={canWrite}
            lastTest={tests.get(summary.integration.id)}
            onTested={recordTest}
            onEdit={() => setEditor({ integration: summary.integration })}
          />
        ))
      )}
      <OverlayPresence when={editor !== null && environmentId !== null ? editor : null}>
        {(open) =>
          environmentId === null ? null : (
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
    </SettingsSection>
  );
}

function IntegrationRow({
  environmentId,
  summary,
  labels,
  canWrite,
  lastTest,
  onTested,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: IntegrationSummary;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly canWrite: boolean;
  readonly lastTest: IntegrationTest | undefined;
  readonly onTested: (integration: Integration, result: IntegrationTestResult) => void;
  readonly onEdit: () => void;
}) {
  const { integration } = summary;
  const update = useOrchestrationCommand(integrationsRpc.update, { reportFailure: false });
  const remove = useOrchestrationCommand(integrationsRpc.remove, { reportFailure: false });
  const test = useOrchestrationCommand(integrationsRpc.testConnection, { reportFailure: false });
  const beginSignIn = useOrchestrationCommand(integrationsRpc.beginSignIn, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const status = integrationStatus(summary, lastTest);
  const tools = toolCountLabel(status.toolCount);
  const title = integrationTitle(integration);
  const signIn = signInAction(summary);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const toggle = (enabled: boolean) =>
    run(async () => {
      settled(
        `Could not turn ${integration.displayName} ${enabled ? "on" : "off"}`,
        await update({ environmentId, input: { id: integration.id, enabled } }),
      );
    });
  const testNow = () =>
    run(async () => {
      const result = settled(
        `Could not test ${integration.displayName}`,
        await test({ environmentId, input: { id: integration.id } }),
      );
      if (result === null) return;
      onTested(integration, result);
      toastManager.add(
        result.status === "connected"
          ? {
              type: "success",
              title: `${integration.displayName} is connected`,
              description: toolCountLabel(result.toolCount) ?? undefined,
            }
          : {
              type: "error",
              title: `${integration.displayName} could not connect`,
              description: testResultReason(result) ?? undefined,
            },
      );
    });
  // The row updates itself when the callback lands: the list is live.
  const signInNow = () =>
    run(() =>
      openSignInPage(async () => {
        const started = settled(
          `Could not start sign-in to ${title}`,
          await beginSignIn({ environmentId, input: { id: integration.id } }),
        );
        return started?.authorizationUrl ?? null;
      }),
    );
  const removeNow = () =>
    run(async () => {
      const message = `Remove “${title}”?\nAgents can no longer use it. Vault items it referenced stay in the vault; its sign-in is deleted.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
      settled(
        `Could not remove ${integration.displayName}`,
        await remove({ environmentId, input: { id: integration.id } }),
      );
    });

  return (
    <SettingsRow
      title={title}
      description={`${integration.name} · ${urlHost(integration.url)} · ${scopeLabel(integration.scope, labels)}`}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <Badge size="sm" variant={status.tone === "neutral" ? "outline" : status.tone}>
            {status.label}
          </Badge>
          {tools ? <span>{tools}</span> : null}
          {status.reason ? (
            <span className={status.tone === "error" ? "text-destructive" : undefined}>
              {status.reason}
            </span>
          ) : null}
          {status.checkedAt ? (
            <span className="text-muted-foreground">
              Checked {formatRelativeTimeLabel(status.checkedAt)}
            </span>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          {signIn === "Sign in" && integration.enabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canWrite}
              onClick={() => void signInNow()}
            >
              <LogInIcon className="size-3" />
              Sign in
            </Button>
          ) : null}
          <Switch
            checked={integration.enabled}
            disabled={busy || !canWrite}
            aria-label={`Use ${integration.displayName}`}
            onCheckedChange={(checked) => void toggle(Boolean(checked))}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canWrite}
                  aria-label={`Actions for ${integration.displayName}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem disabled={!integration.enabled} onClick={() => void testNow()}>
                <PlugZapIcon />
                Test connection
              </MenuItem>
              {signIn === null ? null : (
                <MenuItem disabled={!integration.enabled} onClick={() => void signInNow()}>
                  <LogInIcon />
                  {signIn}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void removeNow()}>
                <Trash2Icon />
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

/** Add or edit one integration, with a connection test against what was saved. */
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
        "Could not add the integration",
        await create({ environmentId, input: { ...valid.fields, enabled: true } }),
      );
      if (created) setStored(created.integration);
      return created?.integration ?? null;
    }
    if (!draftChanges(stored, valid.fields)) return stored;
    const updated = settled(
      "Could not save the integration",
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
        "Could not test the integration",
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
          "Could not start sign-in",
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
          <DialogTitle>{props.integration ? "Edit integration" : "Add integration"}</DialogTitle>
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
                    placeholder="Gmail"
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
                    placeholder="gmail"
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
                  Tells two connections to one service apart, like two Slack workspaces.
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
                  Most hosted servers, like Linear, Notion and GitHub, use this. You sign in once in
                  your browser; agents keep access after that.
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
                            loading={vault.data === null && vault.error === null}
                            onPick={(reference) => edit({ clientSecret: reference })}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Only for services that don't register Cogenly by themselves, such as Slack:
                        create an app there
                        {callbackUrl ? `, add ${callbackUrl} as its redirect URL,` : ""} and enter
                        its client ID and the vault item holding its secret.
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
                        loading={vault.data === null && vault.error === null}
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
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Available in</div>
                <Select
                  value={draft.scope}
                  onValueChange={(value) => {
                    if (value === "all" || value === "projects") edit({ scope: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Available in">
                    <SelectValue>
                      {draft.scope === "all" ? "All projects" : "Chosen projects"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="all">All projects</SelectItem>
                    <SelectItem value="projects">Chosen projects</SelectItem>
                  </SelectPopup>
                </Select>
                <AnimatedHeight>
                  {draft.scope === "projects" ? (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <ProjectLabelChips labels={props.labels} ids={draft.labelIds} />
                      <ProjectLabelPicker
                        labels={props.labels}
                        selectedIds={draft.labelIds}
                        onToggle={(id, selected) =>
                          edit({
                            labelIds: selected
                              ? [...draft.labelIds, id]
                              : draft.labelIds.filter((other) => other !== id),
                          })
                        }
                      />
                    </div>
                  ) : null}
                </AnimatedHeight>
              </div>
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
                      Turn the integration on to test it.
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
            {pending === "save" ? "Saving…" : stored !== null ? "Save" : "Add integration"}
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

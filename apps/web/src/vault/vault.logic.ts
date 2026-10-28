import { defaultVaultPolicy, isDefaultVaultPolicy } from "@cogenly/contracts";
import type {
  AgentId,
  ProjectLabelId,
  ThreadId,
  VaultCreateInput,
  VaultItemId,
  VaultItemMetadata,
  VaultItemPortability,
  VaultItemType,
  VaultPolicy,
  VaultSecretFields,
  VaultUpdateInput,
  VaultUsageEntry,
} from "@cogenly/contracts";

export const VAULT_TYPE_LABELS: Readonly<Record<VaultItemType, string>> = {
  login: "Login",
  api_key: "API key",
  card: "Card",
  note: "Note",
};

export const VAULT_TYPES: ReadonlyArray<VaultItemType> = ["login", "api_key", "card", "note"];

type VaultSecretKey = keyof VaultSecretFields;

/**
 * One input in the add/edit form. `label` is the item's plaintext display
 * text; every other key is a secret slot that is write-only after save.
 */
export interface VaultFormField {
  readonly key: VaultSecretKey | "label";
  readonly title: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly multiline?: boolean;
}

/**
 * Fields by type. A card has its own encrypted fields (number, expiry
 * month/year, CVC and cardholder name), so nothing secret rides in the
 * plaintext `label`; the label is only display text, as on a login.
 */
export const VAULT_FIELDS_BY_TYPE: Readonly<Record<VaultItemType, ReadonlyArray<VaultFormField>>> =
  {
    login: [
      { key: "username", title: "Username or email" },
      { key: "label", title: "Label", placeholder: "Site · username" },
      { key: "password", title: "Password", required: true },
      { key: "totpSecret", title: "One-time code secret", placeholder: "Optional" },
    ],
    api_key: [{ key: "value", title: "Key", required: true }],
    card: [
      { key: "label", title: "Description", placeholder: "Personal Visa" },
      { key: "cardNumber", title: "Card number", required: true },
      { key: "cardExpiryMonth", title: "Expiry month", placeholder: "MM" },
      { key: "cardExpiryYear", title: "Expiry year", placeholder: "YYYY" },
      { key: "cardCvc", title: "CVC" },
      { key: "cardholderName", title: "Name on card" },
    ],
    note: [{ key: "value", title: "Text", required: true, multiline: true }],
  };

/** Allowed domains are where a fill may type the value: logins and cards. */
export const vaultTypeHasDomains = (type: VaultItemType) => type === "login" || type === "card";

export type VaultPolicyMode = VaultPolicy["mode"];

export interface VaultDraft {
  readonly name: string;
  readonly type: VaultItemType;
  readonly label: string;
  readonly secrets: Readonly<Record<VaultSecretKey, string>>;
  readonly allowedDomains: string;
  readonly scopeProjectId: ProjectLabelId | null;
  readonly policyMode: VaultPolicyMode;
  readonly policyAgentIds: ReadonlyArray<AgentId>;
  readonly policyDomains: string;
  /** Sites outside the allowed ones the owner approved fills on; kept as they are. */
  readonly policyApprovedDomains: ReadonlyArray<string>;
  /** The owner picked the access rule by hand, so a later default change leaves it. */
  readonly policyOwnerSet: boolean;
  /**
   * The owner's own choice; a rule can still keep a `shared` item here. Null
   * when the server predates vault sync, so saving leaves it alone.
   */
  readonly portability: VaultItemPortability | null;
}

const EMPTY_SECRETS: Record<VaultSecretKey, string> = {
  username: "",
  password: "",
  totpSecret: "",
  value: "",
  cardNumber: "",
  cardExpiryMonth: "",
  cardExpiryYear: "",
  cardCvc: "",
  cardholderName: "",
};

/** A blank draft for a new item, or the editable metadata of a saved one; secrets stay blank. */
export function vaultDraftFromItem(
  item: VaultItemMetadata | null,
  defaults: {
    readonly scopeProjectId?: ProjectLabelId | null;
    readonly type?: VaultItemType;
  } = {},
): VaultDraft {
  return {
    name: item?.name ?? "",
    type: item?.type ?? defaults.type ?? "login",
    label: item?.label ?? "",
    secrets: EMPTY_SECRETS,
    allowedDomains: item?.allowedDomains.join(", ") ?? "",
    scopeProjectId: item ? item.scopeProjectId : (defaults.scopeProjectId ?? null),
    policyMode: item?.policy.mode ?? defaultVaultPolicy.mode,
    policyAgentIds: item?.policy.allowedAgentIds ?? [],
    policyDomains: item?.policy.allowedDomains.join(", ") ?? "",
    policyApprovedDomains: item?.policy.approvedDomains ?? [],
    policyOwnerSet: item?.policy.ownerSet ?? false,
    portability: vaultOwnerPortability(item),
  };
}

/**
 * What the owner chose for an item. The server reports a reason only when a
 * rule, not the owner, keeps it here, so an item with a reason was left shared.
 */
function vaultOwnerPortability(item: VaultItemMetadata | null): VaultItemPortability | null {
  if (item === null) return "shared";
  if (item.portability === undefined) return null;
  return item.portabilityReason === undefined ? item.portability : "shared";
}

/** Hosts from free text: comma, space or newline separated; schemes, paths and ports dropped. */
export function parseDomainList(text: string): Array<string> {
  const domains = text
    .split(/[\s,]+/)
    .map((entry) => {
      const trimmed = entry.trim().toLowerCase();
      if (!trimmed) return "";
      const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
      return withoutScheme.split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
    })
    .filter((entry) => entry.length > 0 && entry.length <= 253);
  return [...new Set(domains)];
}

/** Why the draft cannot be saved yet, or null. Editing never requires secrets again. */
export function vaultDraftProblem(draft: VaultDraft, mode: "create" | "edit"): string | null {
  if (draft.name.trim().length === 0) return "Name the item.";
  if (mode === "create") {
    const missing = VAULT_FIELDS_BY_TYPE[draft.type].find(
      (field) => field.required && field.key !== "label" && draft.secrets[field.key] === "",
    );
    if (missing) return `Enter the ${missing.title.toLowerCase()}.`;
  }
  if (draft.type === "card") {
    const month = draft.secrets.cardExpiryMonth.trim();
    const year = draft.secrets.cardExpiryYear.trim();
    if (month !== "" || year !== "") {
      const monthOk = /^\d{1,2}$/.test(month) && Number(month) >= 1 && Number(month) <= 12;
      const yearOk = /^\d{2}$/.test(year) || /^\d{4}$/.test(year);
      if (!monthOk || !yearOk) return "Enter the full expiry (month and year).";
    }
  }
  return null;
}

function vaultPolicyFromDraft(draft: VaultDraft): VaultPolicy {
  const extras = {
    ...(draft.policyApprovedDomains.length > 0
      ? { approvedDomains: [...draft.policyApprovedDomains] }
      : {}),
    ...(draft.policyOwnerSet ? { ownerSet: true } : {}),
  };
  return draft.policyMode === "allow"
    ? {
        mode: "allow",
        allowedAgentIds: [...draft.policyAgentIds],
        allowedDomains: parseDomainList(draft.policyDomains),
        ...extras,
      }
    : { mode: draft.policyMode, allowedAgentIds: [], allowedDomains: [], ...extras };
}

/** The secret fields this type uses that the owner typed something into. */
function typedSecrets(draft: VaultDraft): VaultSecretFields {
  const secrets: { -readonly [K in VaultSecretKey]?: string } = {};
  for (const field of VAULT_FIELDS_BY_TYPE[draft.type]) {
    if (field.key === "label") continue;
    const value = draft.secrets[field.key];
    if (value !== "") secrets[field.key] = value;
  }
  return secrets;
}

function hasLabel(type: VaultItemType) {
  return VAULT_FIELDS_BY_TYPE[type].some((field) => field.key === "label");
}

export function vaultCreateInput(draft: VaultDraft): VaultCreateInput {
  const label = draft.label.trim();
  return {
    name: draft.name.trim(),
    type: draft.type,
    scopeProjectId: draft.scopeProjectId,
    ...(hasLabel(draft.type) && label ? { label } : {}),
    allowedDomains: vaultTypeHasDomains(draft.type) ? parseDomainList(draft.allowedDomains) : [],
    policy: vaultPolicyFromDraft(draft),
    ...(draft.portability === "machine" ? { portability: "machine" } : {}),
    secretFields: typedSecrets(draft),
  };
}

/** Metadata always; secret fields only when typed, so blank inputs leave stored values alone. */
export function vaultUpdateInput(id: VaultItemId, draft: VaultDraft): VaultUpdateInput {
  const label = draft.label.trim();
  const secrets = typedSecrets(draft);
  return {
    id,
    name: draft.name.trim(),
    scopeProjectId: draft.scopeProjectId,
    ...(hasLabel(draft.type) ? { label: label || null } : {}),
    ...(vaultTypeHasDomains(draft.type)
      ? { allowedDomains: parseDomainList(draft.allowedDomains) }
      : {}),
    policy: vaultPolicyFromDraft(draft),
    ...(draft.portability === null ? {} : { portability: draft.portability }),
    ...(Object.keys(secrets).length > 0 ? { secretFields: secrets } : {}),
  };
}

/**
 * The item's rule after the owner picked an access option in place: the
 * mode and agents change, sites they approved before stay, and the rule is
 * marked as the owner's own choice.
 */
export function vaultPolicyWithAccess(
  policy: VaultPolicy,
  patch: { readonly mode?: VaultPolicyMode; readonly agentIds?: ReadonlyArray<AgentId> },
): VaultPolicy {
  const mode = patch.mode ?? policy.mode;
  return {
    ...policy,
    mode,
    allowedAgentIds: mode === "allow" ? [...(patch.agentIds ?? policy.allowedAgentIds)] : [],
    allowedThreadIds: mode === "allow" ? (policy.allowedThreadIds ?? []) : [],
    allowedDomains: mode === "allow" ? policy.allowedDomains : [],
    ownerSet: true,
  };
}

/**
 * The access rule in a few words: the default ("Agents fill it on its sites"),
 * "Asks you first", "Blocked", or who (and where) may use it without asking.
 */
export function vaultPolicySummary(
  policy: VaultPolicy,
  agentName: (id: AgentId) => string | undefined,
): string {
  if (policy.mode === "ask") return "Asks you first";
  if (policy.mode === "deny") return "Blocked for agents";
  if (isDefaultVaultPolicy(policy)) return "Agents fill it on its sites";
  const agents =
    policy.allowedAgentIds.length === 0
      ? "Any agent"
      : policy.allowedAgentIds.map((id) => agentName(id) ?? "a deleted agent").join(", ");
  const domains =
    policy.allowedDomains.length === 0 ? "" : ` on ${policy.allowedDomains.join(", ")}`;
  return `${agents} may use it${domains}`;
}

/** Items by name, case-insensitively, then type so same-named items in two scopes stay stable. */
export function sortVaultItems(
  items: ReadonlyArray<VaultItemMetadata>,
): ReadonlyArray<VaultItemMetadata> {
  return items.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id),
  );
}

/** The newest use per item: a fill or other delivery that went through, else any entry. */
export function lastUsedByItem(
  usage: ReadonlyArray<VaultUsageEntry>,
): ReadonlyMap<VaultItemId, VaultUsageEntry> {
  const latest = new Map<VaultItemId, VaultUsageEntry>();
  for (const entry of usage) {
    const current = latest.get(entry.itemId);
    const better =
      current === undefined ||
      (entry.outcome === "allowed" && current.outcome !== "allowed") ||
      ((entry.outcome === "allowed") === (current.outcome === "allowed") && entry.at > current.at);
    if (better) latest.set(entry.itemId, entry);
  }
  return latest;
}

/** "Used 2 hours ago by Inbox agent", "… in a chat", or "Never used". */
export function vaultLastUsedText(
  entry: VaultUsageEntry | undefined,
  agentName: (id: AgentId) => string | undefined,
  relative: (at: string) => string,
): string {
  if (entry === undefined) return "Never used";
  const who = entry.agentId
    ? ` by ${agentName(entry.agentId) ?? "a deleted agent"}`
    : entry.threadId
      ? " in a chat"
      : "";
  return `Used ${relative(entry.at)}${who}`;
}

// Names Cogenly generates for items an integration's setup stores, such as
// `integration-endpoint:<uuid>`: a kind, a colon and an id.
const GENERATED_NAME = /^[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/**
 * What a vault item is called in a list. An item with a generated name and a
 * human label ("Wispr Flow private endpoint") is titled by the label, with the
 * generated name kept as `internalName` for agents and support; every other
 * item keeps its own name as the title and its label as the description.
 */
export function vaultItemDisplay(item: Pick<VaultItemMetadata, "name" | "label">): {
  readonly title: string;
  readonly description: string | null;
  readonly internalName: string | null;
} {
  const label = item.label?.trim() || null;
  if (label !== null && GENERATED_NAME.test(item.name)) {
    return { title: label, description: null, internalName: item.name };
  }
  return { title: item.name, description: label, internalName: null };
}

/** A run of identical uses (same item, action, outcome, site and user), newest first. */
export interface VaultUsageGroup {
  readonly entry: VaultUsageEntry;
  readonly count: number;
}

/**
 * Collapses consecutive identical uses into one line with a count, so an
 * item filled every hour reads as one entry instead of a page of them. The
 * kept entry is the newest of its run.
 */
export function groupVaultUsage(usage: ReadonlyArray<VaultUsageEntry>): Array<VaultUsageGroup> {
  const groups: Array<{ entry: VaultUsageEntry; count: number }> = [];
  for (const entry of usage) {
    const last = groups.at(-1);
    if (
      last !== undefined &&
      last.entry.itemId === entry.itemId &&
      last.entry.action === entry.action &&
      last.entry.outcome === entry.outcome &&
      last.entry.domain === entry.domain &&
      last.entry.agentId === entry.agentId &&
      last.entry.threadId === entry.threadId
    ) {
      last.count += 1;
    } else {
      groups.push({ entry, count: 1 });
    }
  }
  return groups;
}

/** Logins first (they get their own list), then everything else. */
export function splitVaultItems(items: ReadonlyArray<VaultItemMetadata>): {
  readonly logins: ReadonlyArray<VaultItemMetadata>;
  readonly others: ReadonlyArray<VaultItemMetadata>;
} {
  const sorted = sortVaultItems(items);
  return {
    logins: sorted.filter((item) => item.type === "login"),
    others: sorted.filter((item) => item.type !== "login"),
  };
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  allowed: "Allowed",
  approval_required: "Waited for approval",
  denied_domain: "Blocked on this site",
  denied_policy: "Denied",
  field_missing: "Field missing",
  saved: "Saved",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  fill: "Filled",
  // The line names who used it ("Cogenly", an agent) after the site.
  resolve: "Used",
  use: "Used",
};

/**
 * An entry written when the user answered an agent's sign-in card, with the
 * thread it was saved from; null for any other use.
 */
export function vaultSavedFromThread(
  entry: Pick<VaultUsageEntry, "action" | "threadId">,
): { readonly threadId: ThreadId; readonly updated: boolean } | null {
  if (entry.threadId === null) return null;
  if (entry.action === "saved_from_request") return { threadId: entry.threadId, updated: false };
  if (entry.action === "updated_from_request") return { threadId: entry.threadId, updated: true };
  return null;
}

const humanize = (text: string) => {
  const spaced = text.replaceAll("_", " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export const vaultOutcomeLabel = (outcome: string) => OUTCOME_LABELS[outcome] ?? humanize(outcome);
export const vaultActionLabel = (action: string) => ACTION_LABELS[action] ?? humanize(action);
export const vaultOutcomeTone = (outcome: string): "success" | "warning" | "error" =>
  outcome === "allowed" || outcome === "saved"
    ? "success"
    : outcome === "approval_required"
      ? "warning"
      : "error";

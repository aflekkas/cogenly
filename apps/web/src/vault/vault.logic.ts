import type {
  AgentId,
  ProjectLabelId,
  VaultCreateInput,
  VaultItemId,
  VaultItemMetadata,
  VaultItemType,
  VaultPolicy,
  VaultSecretFields,
  VaultUpdateInput,
  VaultUsageEntry,
} from "@t3tools/contracts";

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
 * Fields by type. The server stores four secret slots, so a card maps onto
 * them: number in `value`, CVC in `password`, name in `username`, and the
 * expiry, which is printed on the card and not a secret, in `label`.
 */
export const VAULT_FIELDS_BY_TYPE: Readonly<Record<VaultItemType, ReadonlyArray<VaultFormField>>> =
  {
    login: [
      { key: "label", title: "Label", placeholder: "Work GitHub" },
      { key: "username", title: "Username or email" },
      { key: "password", title: "Password", required: true },
      { key: "totpSecret", title: "One-time code secret", placeholder: "Optional" },
    ],
    api_key: [{ key: "value", title: "Key", required: true }],
    card: [
      { key: "value", title: "Card number", required: true },
      { key: "label", title: "Expiry", placeholder: "MM/YY" },
      { key: "password", title: "CVC" },
      { key: "username", title: "Name on card" },
    ],
    note: [{ key: "value", title: "Text", required: true, multiline: true }],
  };

/** Allowed domains belong to logins: they are where a fill may type the value. */
export const vaultTypeHasDomains = (type: VaultItemType) => type === "login";

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
}

const EMPTY_SECRETS: Record<VaultSecretKey, string> = {
  username: "",
  password: "",
  totpSecret: "",
  value: "",
};

/** A blank draft for a new item, or the editable metadata of a saved one; secrets stay blank. */
export function vaultDraftFromItem(
  item: VaultItemMetadata | null,
  defaults: { readonly scopeProjectId?: ProjectLabelId | null } = {},
): VaultDraft {
  return {
    name: item?.name ?? "",
    type: item?.type ?? "login",
    label: item?.label ?? "",
    secrets: EMPTY_SECRETS,
    allowedDomains: item?.allowedDomains.join(", ") ?? "",
    scopeProjectId: item ? item.scopeProjectId : (defaults.scopeProjectId ?? null),
    policyMode: item?.policy.mode ?? "ask",
    policyAgentIds: item?.policy.allowedAgentIds ?? [],
    policyDomains: item?.policy.allowedDomains.join(", ") ?? "",
  };
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
  return null;
}

function vaultPolicyFromDraft(draft: VaultDraft): VaultPolicy {
  return draft.policyMode === "ask"
    ? { mode: "ask", allowedAgentIds: [], allowedDomains: [] }
    : {
        mode: "allow",
        allowedAgentIds: [...draft.policyAgentIds],
        allowedDomains: parseDomainList(draft.policyDomains),
      };
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
    ...(Object.keys(secrets).length > 0 ? { secretFields: secrets } : {}),
  };
}

/** "Agents ask first", or who (and where) may use the item without asking. */
export function vaultPolicySummary(
  policy: VaultPolicy,
  agentName: (id: AgentId) => string | undefined,
): string {
  if (policy.mode === "ask") return "Agents ask first";
  const agents =
    policy.allowedAgentIds.length === 0
      ? "all agents"
      : policy.allowedAgentIds.map((id) => agentName(id) ?? "a deleted agent").join(", ");
  const domains =
    policy.allowedDomains.length === 0 ? "" : ` on ${policy.allowedDomains.join(", ")}`;
  return `Allowed for: ${agents}${domains}`;
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

/** The newest usage time per item. */
export function lastUsedByItem(
  usage: ReadonlyArray<VaultUsageEntry>,
): ReadonlyMap<VaultItemId, string> {
  const latest = new Map<VaultItemId, string>();
  for (const entry of usage) {
    const current = latest.get(entry.itemId);
    if (current === undefined || entry.at > current) latest.set(entry.itemId, entry.at);
  }
  return latest;
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  allowed: "Allowed",
  approval_required: "Waited for approval",
  denied_domain: "Blocked on this site",
  denied_policy: "Denied",
  field_missing: "Field missing",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  fill: "Filled",
  resolve: "Used by Cogenly",
  use: "Used",
};

const humanize = (text: string) => {
  const spaced = text.replaceAll("_", " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export const vaultOutcomeLabel = (outcome: string) => OUTCOME_LABELS[outcome] ?? humanize(outcome);
export const vaultActionLabel = (action: string) => ACTION_LABELS[action] ?? humanize(action);
export const vaultOutcomeTone = (outcome: string): "success" | "warning" | "error" =>
  outcome === "allowed" ? "success" : outcome === "approval_required" ? "warning" : "error";

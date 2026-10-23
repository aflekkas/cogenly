import {
  isIntegrationError,
  type Integration,
  type IntegrationCreateInput,
  type IntegrationError,
  type IntegrationScope,
  type IntegrationSummary,
  type IntegrationTestResult,
  type IntegrationUpdateInput,
  type ProjectLabelId,
  type VaultField,
  type VaultItemMetadata,
} from "@t3tools/contracts";

const NAME_MAX_LENGTH = 64;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const CREDENTIAL_REF = /\{\{credential:([^}]*)\}\}/g;

/** "Gmail (work)" -> "gmail-work": the slug agents call an integration by. */
export function slugifyIntegrationName(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/, "");
}

export function isValidIntegrationName(name: string): boolean {
  return name.length <= NAME_MAX_LENGTH && NAME_PATTERN.test(name);
}

export interface HeaderRow {
  readonly key: string;
  readonly value: string;
}

export function headersToRows(headers: Readonly<Record<string, string>>): HeaderRow[] {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

/** Rows back to a header record; blank rows are dropped, a half-filled or repeated name is an error. */
export function rowsToHeaders(
  rows: ReadonlyArray<HeaderRow>,
): { readonly headers: Record<string, string> } | { readonly error: string } {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "" && row.value.trim() === "") continue;
    if (key === "") return { error: "Every header value needs a header name." };
    if (/[\s:]/.test(key)) return { error: `“${key}” is not a valid header name.` };
    const folded = key.toLowerCase();
    if (seen.has(folded)) return { error: `“${key}” is listed twice.` };
    seen.add(folded);
    headers[key] = row.value;
  }
  return { headers };
}

export function credentialReference(item: string, field: VaultField): string {
  return `{{credential:${item}.${field}}}`;
}

/** Appends a reference to a header value, keeping a typed prefix such as "Bearer". */
export function insertCredentialReference(value: string, reference: string): string {
  if (value === "" || /\s$/.test(value)) return `${value}${reference}`;
  return `${value} ${reference}`;
}

export interface CredentialReference {
  readonly item: string;
  readonly field: string;
}

/** Same parse as the server: the item name is everything before the last dot. */
export function credentialReferencesIn(value: string): CredentialReference[] {
  return [...value.matchAll(CREDENTIAL_REF)].flatMap((match) => {
    const ref = (match[1] ?? "").trim();
    const dot = ref.lastIndexOf(".");
    if (dot <= 0 || dot === ref.length - 1) return [{ item: ref, field: "" }];
    return [{ item: ref.slice(0, dot).trim(), field: ref.slice(dot + 1).trim() }];
  });
}

/** References no vault item can fill, so the user hears before agents do. */
export function unresolvedCredentialReferences(
  headers: Readonly<Record<string, string>>,
  vaultItems: ReadonlyArray<Pick<VaultItemMetadata, "name" | "fields">>,
): CredentialReference[] {
  const byName = new Map(vaultItems.map((item) => [item.name, item]));
  return Object.values(headers)
    .flatMap(credentialReferencesIn)
    .filter((ref) => {
      const item = byName.get(ref.item);
      return item === undefined || !item.fields.some((field) => field === ref.field);
    });
}

/** Vault items a header can reference; names with braces cannot survive the template. */
export function referenceableVaultItems<T extends Pick<VaultItemMetadata, "name" | "fields">>(
  items: ReadonlyArray<T>,
): T[] {
  return items
    .filter((item) => item.fields.length > 0 && !/[{}]/.test(item.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export const VAULT_FIELD_LABEL: Readonly<Record<VaultField, string>> = {
  username: "Username",
  password: "Password",
  totp: "One-time code",
  value: "Value",
  cardNumber: "Card number",
  cardExpiry: "Card expiry",
  cardCvc: "Card CVC",
  cardholderName: "Name on card",
};

const REASON_TEXT: Readonly<Record<IntegrationError["reason"], string>> = {
  storage: "Cogenly could not read or save this integration.",
  not_found: "This integration no longer exists.",
  conflict: "Another integration already uses this name.",
  disabled: "Turn the integration on to test it.",
  credential_unresolved: "A vault reference in the headers does not match a vault item.",
  credential_not_allowed:
    "A vault item in the headers doesn't allow this server. Save the integration to approve it, or add the server to the item's allowed domains.",
  upstream_unreachable: "The server could not be reached.",
  upstream_timeout: "The server took too long to answer.",
  upstream_error: "The server answered with an error.",
  invalid_request: "The server rejected the request.",
  approval_required: "Widening project access needs owner approval.",
  sign_in_required: "Sign in to this service to use it.",
  client_id_required:
    "This service does not register apps automatically. Create an OAuth app with it and enter its client ID and secret.",
};

export function integrationReasonText(reason: IntegrationError["reason"]): string {
  return REASON_TEXT[reason];
}

/** Plain text for a failed integrations RPC. */
export function integrationErrorText(error: unknown): string {
  if (isIntegrationError(error)) return REASON_TEXT[error.reason];
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The server rejected the change.";
}

/** The server words a failed test as "Could not connect (<reason>)."; this makes it plain. */
export function testResultReason(result: IntegrationTestResult): string | null {
  if (result.status === "connected") return null;
  const token = /\(([a-z_]+)\)/.exec(result.message)?.[1];
  return token !== undefined && token in REASON_TEXT
    ? REASON_TEXT[token as IntegrationError["reason"]]
    : result.message;
}

export function toolCountLabel(count: number | null): string | null {
  if (count === null) return null;
  return count === 1 ? "1 tool" : `${count} tools`;
}

export interface IntegrationStatusView {
  readonly tone: "success" | "error" | "neutral";
  readonly label: string;
  readonly reason: string | null;
  readonly toolCount: number | null;
}

/** A test from this page, tied to the integration version it ran against. */
export interface IntegrationTest {
  readonly updatedAt: string;
  readonly result: IntegrationTestResult;
}

/**
 * What a row shows. The list only reports tools an agent listed recently, and
 * a test does not fill that cache, so the latest test of the current version
 * wins; an edit makes it stale.
 */
export function integrationStatus(
  summary: IntegrationSummary,
  lastTest: IntegrationTest | undefined,
): IntegrationStatusView {
  if (!summary.integration.enabled) {
    return { tone: "neutral", label: "Off", reason: null, toolCount: null };
  }
  const test = lastTest?.updatedAt === summary.integration.updatedAt ? lastTest.result : undefined;
  if (test !== undefined) {
    return test.status === "connected"
      ? { tone: "success", label: "Connected", reason: null, toolCount: test.toolCount }
      : { tone: "error", label: "Error", reason: testResultReason(test), toolCount: null };
  }
  if (summary.status === "connected") {
    return { tone: "success", label: "Connected", reason: null, toolCount: summary.toolCount };
  }
  return { tone: "neutral", label: "Not checked", reason: null, toolCount: null };
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function scopeLabel(
  scope: IntegrationScope,
  labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string {
  if (scope.type === "all") return "All projects";
  const names = scope.labelIds.flatMap((id) => {
    const label = labels.find((candidate) => candidate.id === id);
    return label ? [label.name] : [];
  });
  if (names.length === 0) return "No projects";
  return names.join(", ");
}

export interface IntegrationDraft {
  readonly displayName: string;
  readonly name: string;
  /** False until the user types a name, so it follows the display name. */
  readonly nameEdited: boolean;
  readonly url: string;
  readonly headers: ReadonlyArray<HeaderRow>;
  readonly hint: string;
  readonly scope: "all" | "projects";
  readonly labelIds: ReadonlyArray<ProjectLabelId>;
}

export const EMPTY_INTEGRATION_DRAFT: IntegrationDraft = {
  displayName: "",
  name: "",
  nameEdited: false,
  url: "",
  headers: [{ key: "Authorization", value: "" }],
  hint: "",
  scope: "all",
  labelIds: [],
};

export function draftFromIntegration(integration: Integration): IntegrationDraft {
  return {
    displayName: integration.displayName,
    name: integration.name,
    nameEdited: true,
    url: integration.url,
    headers: headersToRows(integration.headers),
    hint: integration.hint,
    scope: integration.scope.type,
    labelIds: integration.scope.type === "projects" ? integration.scope.labelIds : [],
  };
}

export function withDisplayName(draft: IntegrationDraft, displayName: string): IntegrationDraft {
  return {
    ...draft,
    displayName,
    name: draft.nameEdited ? draft.name : slugifyIntegrationName(displayName),
  };
}

type ValidDraft = Omit<IntegrationCreateInput, "enabled">;

/** The first problem with a draft, or the fields to send. */
export function validateIntegrationDraft(
  draft: IntegrationDraft,
): { readonly fields: ValidDraft } | { readonly error: string } {
  const displayName = draft.displayName.trim();
  if (displayName === "") return { error: "Add a display name." };
  const name = draft.name.trim();
  if (!isValidIntegrationName(name)) {
    return {
      error:
        "Use lowercase letters, numbers, - and _ for the name, starting with a letter or digit.",
    };
  }
  const url = draft.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Enter the server's full URL, starting with https://." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "The URL must start with https:// or http://." };
  }
  const headers = rowsToHeaders(draft.headers);
  if ("error" in headers) return headers;
  if (draft.scope === "projects" && draft.labelIds.length === 0) {
    return { error: "Choose at least one project, or make it available everywhere." };
  }
  const scope: IntegrationScope =
    draft.scope === "all" ? { type: "all" } : { type: "projects", labelIds: [...draft.labelIds] };
  return {
    fields: {
      name,
      displayName,
      transport: "http",
      url,
      headers: headers.headers,
      scope,
      hint: draft.hint.trim(),
    },
  };
}

export function updateInputFromDraft(
  integration: Integration,
  fields: ValidDraft,
): IntegrationUpdateInput {
  return {
    id: integration.id,
    displayName: fields.displayName,
    transport: fields.transport,
    url: fields.url,
    headers: fields.headers,
    scope: fields.scope,
    hint: fields.hint,
  };
}

/** Whether saving the draft would change the stored integration. */
export function draftChanges(integration: Integration, fields: ValidDraft): boolean {
  const current = draftFromIntegration(integration);
  const stored = validateIntegrationDraft(current);
  if ("error" in stored) return true;
  return JSON.stringify(stored.fields) !== JSON.stringify(fields);
}

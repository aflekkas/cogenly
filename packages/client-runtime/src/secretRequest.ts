import type {
  LoginRequestAnswerInput,
  OrchestrationV2LoginRequest,
  OrchestrationV2TurnItem,
  SecretRequestAnswerInput,
} from "@cogenly/contracts";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** Shown under the field: the one promise the card makes about the value. */
export const SECRET_REQUEST_PRIVACY_NOTE = "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

/** What a secret request card shows: the form while pending, otherwise a one-line outcome. */
export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const SAVED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Saved securely and kept private",
};
const DECLINED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Declined",
};
const ENDED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "ended",
  label: "Request ended",
};
const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };
const PENDING_ELSEWHERE_DISPLAY: SecretRequestDisplay = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
};

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved":
      return SAVED_DISPLAY;
    case "declined":
      return DECLINED_DISPLAY;
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

/** A provider sign-in card closes "saved" when its machine reports the provider signed in. */
export function providerSignInRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  return item.secretStatus === "saved"
    ? { kind: "answered", outcome: "saved", label: "Signed in" }
    : secretRequestDisplay(item, visibility);
}

/**
 * Builds the RPC payload for an answer. A save with a blank value returns null,
 * since the server rejects it; callers keep Save disabled instead.
 */
export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId">,
  answer: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } };
  }
  const secret = answer.secret.trim();
  if (secret.length === 0) return null;
  return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save", secret } };
}

/** Failures whose message is written for the user and never echoes the request payload. */
const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Inline error copy for a failed answer. Only known server errors pass their
 * message through: anything else (transport or encoding failures) gets the
 * generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}

/** Shown under a sign-in card's fields: where the login goes and who may use it. */
export const LOGIN_REQUEST_PRIVACY_NOTE = "Saved to your vault, never shown to the agent";

export type LoginRequestField = OrchestrationV2LoginRequest["fields"][number];

/** What the user typed into a sign-in card; only the fields the card asked for are sent. */
export interface LoginRequestDraft {
  readonly username: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly note: string;
  readonly keep: boolean;
}

/** A fresh draft: the agent's username guess prefilled, saving to the vault on. */
export function loginRequestDraft(login: OrchestrationV2LoginRequest): LoginRequestDraft {
  return {
    username: login.usernameHint ?? "",
    password: "",
    totpSecret: "",
    note: "",
    keep: true,
  };
}

/** The site a card is for: its host, and the name to show (the agent's, else the host). */
export function loginRequestSite(login: Pick<OrchestrationV2LoginRequest, "origin" | "siteName">): {
  readonly host: string;
  readonly name: string;
} {
  let host = login.origin;
  try {
    host = new URL(login.origin).hostname;
  } catch {
    // An origin that does not parse is shown as written.
  }
  return { host, name: login.siteName ?? host };
}

/** What a sign-in card shows: the form while pending, otherwise a one-line outcome. */
export function loginRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus" | "login">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved": {
      const name = item.login?.savedItemName;
      const label =
        item.login?.kept === false
          ? "Used for this task only, not kept"
          : item.login?.updateItemId !== undefined
            ? `Updated ${name ?? "the login"} in your vault`
            : name !== undefined
              ? `Saved to your vault as ${name}`
              : "Saved to your vault";
      return { kind: "answered", outcome: "saved", label };
    }
    case "declined":
      return { kind: "answered", outcome: "declined", label: "Skipped" };
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

/**
 * Why Save is unavailable, or null. A card that asks for a password needs
 * one; otherwise any asked field will do.
 */
export function loginRequestDraftProblem(
  fields: ReadonlyArray<LoginRequestField>,
  draft: LoginRequestDraft,
): string | null {
  if (fields.includes("password") && draft.password.trim().length === 0) {
    return "Enter the password.";
  }
  const typed = fields.some((field) => draftValue(draft, field).trim().length > 0);
  return typed ? null : "Enter the login details.";
}

function draftValue(draft: LoginRequestDraft, field: LoginRequestField): string {
  switch (field) {
    case "username":
      return draft.username;
    case "password":
      return draft.password;
    case "totp":
      return draft.totpSecret;
    case "note":
      return draft.note;
  }
}

/**
 * Builds the RPC payload for a sign-in card's answer, sending only the asked
 * fields that were typed. A save the server would reject returns null.
 */
export function loginRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId" | "login">,
  answer:
    | { readonly type: "save"; readonly draft: LoginRequestDraft }
    | { readonly type: "decline" },
): LoginRequestAnswerInput | null {
  const base = { threadId: item.threadId, turnItemId: item.id };
  if (answer.type === "decline") return { ...base, answer: { type: "decline" } };
  const fields = item.login?.fields ?? [];
  if (loginRequestDraftProblem(fields, answer.draft) !== null) return null;
  const typed = (field: LoginRequestField, value: string) =>
    fields.includes(field) && value.trim().length > 0 ? value : undefined;
  const username = typed("username", answer.draft.username.trim());
  const password = typed("password", answer.draft.password);
  const totpSecret = typed("totp", answer.draft.totpSecret.trim());
  const note = typed("note", answer.draft.note);
  return {
    ...base,
    answer: {
      type: "save",
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(totpSecret === undefined ? {} : { totpSecret }),
      ...(note === undefined ? {} : { note }),
      keep: answer.draft.keep,
    },
  };
}

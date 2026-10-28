import {
  LOGIN_REQUEST_PRIVACY_NOTE,
  loginRequestAnswerInput,
  loginRequestDraft,
  loginRequestDraftProblem,
  loginRequestSite,
  secretRequestFailureMessage,
  type LoginRequestDraft,
  type LoginRequestField,
  type SecretRequestItem,
} from "@cogenly/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2LoginRequest } from "@cogenly/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SiteFavicon } from "../SiteFavicon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ThreadPromptCard } from "./ThreadPromptCard";

const FIELD_LABELS: Readonly<Record<LoginRequestField, string>> = {
  username: "Username or email",
  password: "Password",
  totp: "One-time code secret",
  note: "Recovery note",
};

/** Keeps password managers and browsers from saving or filling a card field. */
const NO_AUTOFILL = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
} as const;

/**
 * Pending sign-in card (request_login). Typed values live only in this
 * component's state and the RPC payload, which saves them to the vault: they
 * are never logged, toasted or persisted here, and clear once sent.
 */
export function PendingLoginRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly login: OrchestrationV2LoginRequest;
}) {
  const { item, login } = props;
  const site = loginRequestSite(login);
  const formId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerLoginRequest, {
    label: "answer login request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [draft, setDraft] = useState<LoginRequestDraft>(() => loginRequestDraft(login));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const updating = login.updateItemId !== undefined;
  const problem = loginRequestDraftProblem(login.fields, draft);

  const send = async (
    reply:
      | { readonly type: "save"; readonly draft: LoginRequestDraft }
      | { readonly type: "decline" },
  ) => {
    const input = loginRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setDraft(loginRequestDraft(login));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", draft });
  };

  const fieldProps = (field: LoginRequestField) => ({
    id: `${formId}-${field}`,
    disabled: submitting,
    "aria-invalid": error !== null || undefined,
    "aria-describedby": error !== null ? `${privacyId} ${errorId}` : privacyId,
    ...NO_AUTOFILL,
  });

  return (
    <ThreadPromptCard
      render={<form onSubmit={onSubmit} autoComplete="off" />}
      data-v2-item-type={item.type}
      data-login-request=""
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-5 shrink-0" aria-hidden>
          <SiteFavicon host={site.host} environmentId={props.environmentId} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            {updating ? `Update your ${site.name} login` : `Sign in to ${site.name}`}
          </p>
          <p className="text-xs text-muted-foreground">{site.host}</p>
          {item.reason.trim() ? (
            <p className="text-sm text-muted-foreground">{item.reason}</p>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        {login.fields.map((field) => (
          <div key={field} className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${formId}-${field}`} className="text-xs text-muted-foreground">
              {FIELD_LABELS[field]}
            </label>
            {field === "note" ? (
              <Textarea
                {...fieldProps(field)}
                value={draft.note}
                placeholder="Optional"
                onChange={(event) => setDraft({ ...draft, note: event.currentTarget.value })}
              />
            ) : (
              <Input
                {...fieldProps(field)}
                // Masked text rather than a password field: browsers offer to
                // save any submitted password, and the vault keeps this one.
                type="text"
                className={field === "username" ? undefined : "[-webkit-text-security:disc]"}
                value={
                  field === "username"
                    ? draft.username
                    : field === "password"
                      ? draft.password
                      : draft.totpSecret
                }
                placeholder={field === "totp" ? "Optional" : undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft(
                    field === "username"
                      ? { ...draft, username: value }
                      : field === "password"
                        ? { ...draft, password: value }
                        : { ...draft, totpSecret: value },
                  );
                }}
              />
            )}
          </div>
        ))}
      </div>
      {updating ? (
        <p className="text-xs text-muted-foreground">
          Saved into {login.updateItemName ?? "this login"}. Anything left blank keeps its saved
          value.
        </p>
      ) : (
        <label className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={draft.keep}
            disabled={submitting}
            onCheckedChange={(checked) => setDraft({ ...draft, keep: checked === true })}
          />
          Save to vault
          <span className="text-xs text-muted-foreground">
            {draft.keep
              ? `Agents can sign in to ${site.host} next time`
              : "Removed after this task"}
          </span>
        </label>
      )}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {LOGIN_REQUEST_PRIVACY_NOTE}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={submitting}
            onClick={() => void send({ type: "decline" })}
          >
            Skip
          </Button>
          <Button type="submit" size="sm" disabled={problem !== null} busy={submitting}>
            {updating ? "Update" : "Submit"}
          </Button>
        </div>
      </div>
    </ThreadPromptCard>
  );
}

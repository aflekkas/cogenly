import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * The user's answer to an agent's request for a secret. A saved value is kept
 * by the server under a one-use SecretRef; the thread learns only the status.
 */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const LoginValue = Schema.String.check(Schema.isMaxLength(8192));

/**
 * The user's answer to an agent's sign-in request (request_login). A save goes
 * straight into the vault as a login allowed on the request's site; the
 * thread learns only which item it was saved to. `keep: false` removes the
 * item once the agent's run ends.
 */
export const LoginRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      username: Schema.optional(LoginValue),
      password: Schema.optional(LoginValue),
      totpSecret: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
      note: Schema.optional(Schema.String.check(Schema.isMaxLength(65536))),
      keep: Schema.Boolean,
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type LoginRequestAnswerInput = typeof LoginRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_login: "This request is not a sign-in request.",
  login_empty: "Enter the login details before saving.",
  vault_failed: "Could not save the login to the vault.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

/** Answering a request or using its ref failed; the message is shown to users and agents. */
export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}

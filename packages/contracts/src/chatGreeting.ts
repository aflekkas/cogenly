import * as Schema from "effect/Schema";

/** The client's local time of day; a greeting is written at most once per day and bucket. */
export const ChatGreetingBucket = Schema.Literals(["morning", "afternoon", "evening", "lateNight"]);
export type ChatGreetingBucket = typeof ChatGreetingBucket.Type;

/**
 * The client's local calendar, so a server in another time zone greets for the
 * user's day. `awaitGeneration` waits for a greeting being written instead of
 * answering `pending`.
 */
export const ChatGreetingInput = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  bucket: ChatGreetingBucket,
  /** `Date#getDay`: 0 is Sunday. */
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  awaitGeneration: Schema.optionalKey(Schema.Boolean),
});
export type ChatGreetingInput = typeof ChatGreetingInput.Type;

/**
 * `text` is null when the client should show its built-in greeting. `pending`
 * means one is being written; ask again with `awaitGeneration` to receive it.
 */
export const ChatGreetingResult = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  pending: Schema.Boolean,
});
export type ChatGreetingResult = typeof ChatGreetingResult.Type;

/**
 * How a composer submission is delivered when the thread already has a turn in
 * flight. Shared by web (where the alternate is Mod+Enter) and mobile (where it
 * is a long-press on the send button), so both clients agree on what the user's
 * configured follow-up behavior means.
 */
export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** The alternate switches between queue and steer relative to the configured action. */
export function resolveComposerDispatchMode(input: {
  /** A turn is in flight, so the follow-up has to queue behind it or steer it. */
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /**
   * The provider is waiting out a rate limit. Steering now makes it retry
   * at once and earn another 429, so every send queues behind the turn.
   */
  readonly backingOff?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.backingOff === true) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** What the alternate would do, for labelling the affordance that triggers it. */
export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}

import type { PreviewAutomationControlReason } from "@cogenly/contracts";

export class BrowserControlInterrupted extends Error {
  readonly reason: PreviewAutomationControlReason;
  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewAutomationControlReason = "interrupted",
  ) {
    super(message);
    this.reason = reason;
  }
}

interface SessionControlHooks {
  /** Runs on every owner change; earlier refs no longer point at what the new owner sees. */
  readonly onGenerationChange?: () => void;
  /**
   * Runs in the queue after a viewer loses control to someone else, before the
   * new owner acts, so a held key or button from a half-finished gesture lets go.
   */
  readonly onDisplaced?: (viewerId: string) => Promise<void>;
}

/**
 * Reserves control immediately, but drains running work before the new owner
 * can act. A viewer takes control explicitly, which interrupts an agent action
 * in flight, and may hand it back to the agent. An agent's next action takes
 * control back either way.
 */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  private readonly onDisplaced: (viewerId: string) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  private owner: string | null = null;
  private agentDriving = false;
  /** Sticky: an agent opened the tab or has acted on it, so there is an agent to hand it to. */
  private agentActed: boolean;
  private epoch = 0;
  private closed = false;

  constructor(agentId: string | null, hooks: SessionControlHooks = {}) {
    this.agentId = agentId;
    this.agentActed = agentId !== null;
    this.onGenerationChange = hooks.onGenerationChange ?? (() => {});
    this.onDisplaced = hooks.onDisplaced ?? (async () => {});
  }

  /** The viewer in control, or `null` while an agent (or nobody) drives. */
  get controller() {
    return this.owner;
  }

  /** Whether an agent drives: it opened the tab, or acted since a person last took it. */
  get agentDrives() {
    return this.owner === null && (this.agentId !== null || this.agentDriving);
  }

  /** Whether an agent opened or has acted on this tab, so a viewer can hand control back to it. */
  get agentInvolved() {
    return this.agentActed;
  }

  get generation() {
    return this.epoch;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work: Promise<unknown>) {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending = Promise.all([this.pending, settled]).then(() => undefined);
  }

  private assertOpen() {
    if (this.closed) throw new BrowserControlInterrupted("This browser tab is closed.", "closed");
  }

  /** `displace` lets go of the previous viewer's held input before the new owner acts. */
  private changeOwner(owner: string | null, displace = false) {
    const previous = this.owner;
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
    if (displace && previous !== null)
      this.enqueue(() => this.onDisplaced(previous)).catch(() => {});
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>) {
    this.assertOpen();
    if (!allowed()) throw new BrowserControlInterrupted("You do not control this browser tab.");
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
      return run();
    });
  }

  /** Whether an agent may act here: its own tab, or a tab no agent opened. */
  agentMayAct(agentId: string) {
    return this.agentId === null || this.agentId === agentId;
  }

  /**
   * An agent action. It may act on its own tab or on one a human opened. If a
   * viewer controls the tab, the action takes control back first; a viewer
   * taking control while it runs interrupts it.
   */
  agent<A>(agentId: string, run: () => Promise<A>) {
    try {
      this.claimAgent(agentId);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.action(() => this.agentMayAct(agentId) && this.owner === null, run);
  }

  /**
   * Takes control for an agent step that runs outside the queue, such as
   * answering the dialog a queued click waits on.
   */
  claimAgent(agentId: string) {
    this.assertOpen();
    if (!this.agentMayAct(agentId))
      throw new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch");
    this.agentDriving = true;
    this.agentActed = true;
    if (this.owner !== null) this.changeOwner(null, true);
  }

  /**
   * A read that needs no control and does not queue, so an agent can look at
   * a page while a human drives it without holding up the human's input.
   */
  observe<A>(run: () => Promise<A>) {
    this.assertOpen();
    return run();
  }

  /**
   * Work any client may ask for, such as a viewport or appearance change. It
   * waits its turn behind running actions but needs no control.
   */
  system<A>(run: () => Promise<A>) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.action(() => this.owner === viewerId, run);
  }

  /** Gives this viewer control, from the agent or another viewer; whatever they ran is interrupted. */
  async take(viewerId: string) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      this.agentDriving = false;
      this.changeOwner(viewerId, true);
    }
    return this.human(viewerId, async () => {});
  }

  /**
   * A viewer's page command, such as back or a typed URL: takes control first
   * when someone else has it, as an explicit take would, then runs.
   */
  async takeAndRun<A>(viewerId: string, run: () => Promise<A>) {
    await this.take(viewerId);
    return this.human(viewerId, run);
  }

  /**
   * The viewer in control gives the tab back to the agent that was driving it.
   * Its held input lets go before anyone else acts. Returns false, changing
   * nothing, when the viewer is not in control or no agent has used the tab.
   */
  async handBack(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    if (this.closed || this.owner !== viewerId || !this.agentActed) return false;
    this.agentDriving = true;
    this.changeOwner(null);
    await this.enqueue(afterDrain);
    return true;
  }

  /** A departing viewer gives up control; its held input lets go before anyone else acts. */
  async disconnect(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    if (this.closed || this.owner !== viewerId) return;
    this.changeOwner(null);
    await this.enqueue(afterDrain);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}

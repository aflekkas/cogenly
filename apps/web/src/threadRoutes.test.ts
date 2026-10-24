import { describe, expect, it } from "vite-plus/test";

import { resolveAgentConversationRemoval } from "./threadRoutes";

/** Feeds each render's input through, carrying the latch like the route view does. */
function renders(
  steps: ReadonlyArray<{
    routeThreadKey: string | null;
    agentPresent: boolean;
    agentsSettled?: boolean;
  }>,
): boolean[] {
  let shownAgentThreadKey: string | null = null;
  return steps.map((step) => {
    const result = resolveAgentConversationRemoval({
      shownAgentThreadKey,
      routeThreadKey: step.routeThreadKey,
      agentPresent: step.agentPresent,
      agentsSettled: step.agentsSettled ?? true,
    });
    shownAgentThreadKey = result.shownAgentThreadKey;
    return result.removed;
  });
}

describe("resolveAgentConversationRemoval", () => {
  it("leaves an agent's conversation once the agent is gone from the list", () => {
    expect(
      renders([
        { routeThreadKey: "env:a", agentPresent: true },
        { routeThreadKey: "env:a", agentPresent: false },
      ]),
    ).toEqual([false, true]);
  });

  it("waits while the agents list is still loading or reconnecting", () => {
    expect(
      renders([
        { routeThreadKey: "env:a", agentPresent: false, agentsSettled: false },
        { routeThreadKey: "env:a", agentPresent: true },
        { routeThreadKey: "env:a", agentPresent: false, agentsSettled: false },
        { routeThreadKey: "env:a", agentPresent: false },
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("keeps a leftover conversation open when the route comes back to it later", () => {
    expect(
      renders([
        { routeThreadKey: "env:a", agentPresent: true },
        { routeThreadKey: "env:b", agentPresent: false },
        { routeThreadKey: "env:a", agentPresent: false },
      ]),
    ).toEqual([false, false, false]);
  });

  it("never leaves a thread that was not an agent's conversation", () => {
    expect(renders([{ routeThreadKey: "env:a", agentPresent: false }])).toEqual([false]);
    expect(renders([{ routeThreadKey: null, agentPresent: false }])).toEqual([false]);
  });
});

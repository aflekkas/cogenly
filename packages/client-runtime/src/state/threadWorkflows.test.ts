import type { OrchestrationV2ThreadProjection } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeRunRefusesSteering } from "./threadWorkflows.ts";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;

const projection = (status: string, text: string): Projection =>
  ({
    runs: [{ id: "run-1", status, userMessageId: "message-1" }],
    messages: [{ id: "message-1", text, attachments: [] }],
  }) as unknown as Projection;

describe("activeRunRefusesSteering", () => {
  it("is true while a /compact or /logout turn runs", () => {
    expect(activeRunRefusesSteering(projection("running", " /compact "))).toBe(true);
    expect(activeRunRefusesSteering(projection("starting", "/LOGOUT"))).toBe(true);
  });

  it("is false for ordinary turns and once the compaction ended", () => {
    expect(activeRunRefusesSteering(projection("running", "Fix the tests"))).toBe(false);
    expect(activeRunRefusesSteering(projection("completed", "/compact"))).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { pruneSettledUserInputs, withoutSettledUserInputs } from "./pendingUserInput";

describe("an answered question stays gone until the server drops it", () => {
  const first = { requestId: "request-1" };
  const second = { requestId: "request-2" };

  it("hides a request this client answered while the server still lists it", () => {
    expect(withoutSettledUserInputs([first, second], new Set(["request-1"]))).toEqual([second]);
  });

  it("returns the same list when nothing is held back", () => {
    const pending = [first, second];
    expect(withoutSettledUserInputs(pending, new Set())).toBe(pending);
    expect(withoutSettledUserInputs(pending, new Set(["request-3"]))).toBe(pending);
  });

  it("keeps holding an answer until the server's update arrives", () => {
    const settled = new Set(["request-1"]);
    expect(pruneSettledUserInputs(settled, [first, second])).toBe(settled);
  });

  it("forgets the answer once the server no longer lists the request", () => {
    expect([...pruneSettledUserInputs(new Set(["request-1"]), [second])]).toEqual([]);
  });

  it("a request answered after the server already dropped it is forgotten at once", () => {
    const settled = pruneSettledUserInputs(new Set(["request-1"]), []);
    expect(withoutSettledUserInputs([second], settled)).toEqual([second]);
    expect(settled.size).toBe(0);
  });
});

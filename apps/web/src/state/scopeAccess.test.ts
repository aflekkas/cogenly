import type { AuthSessionState } from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { resolveScopeAccess, sessionHasScope } from "./scopeAccess";

const session: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "cogenly_session",
  },
  scopes: ["orchestration:read"],
  permissions: ["orchestration:read", "terminal:read"],
};

const failed = (previous: boolean, waiting = false) =>
  AsyncResult.failure<AuthSessionState, string>(Cause.fail("timeout"), {
    previousSuccess: previous ? Option.some(AsyncResult.success(session)) : Option.none(),
    waiting,
  });

describe("resolveScopeAccess", () => {
  it("reads a session that has not loaded yet as pending, not denied", () => {
    expect(resolveScopeAccess(AsyncResult.initial(), "terminal:read")).toBe("pending");
    expect(resolveScopeAccess(AsyncResult.initial(true), "terminal:read")).toBe("pending");
  });

  it("answers from a loaded session, also while it revalidates", () => {
    expect(resolveScopeAccess(AsyncResult.success(session), "terminal:read")).toBe("granted");
    expect(resolveScopeAccess(AsyncResult.success(session), "terminal:operate")).toBe("denied");
    expect(
      resolveScopeAccess(AsyncResult.success(session, { waiting: true }), "terminal:read"),
    ).toBe("granted");
  });

  it("denies everything for a session the server no longer accepts", () => {
    expect(
      resolveScopeAccess(
        AsyncResult.success({ ...session, authenticated: false }),
        "terminal:read",
      ),
    ).toBe("denied");
  });

  it("never grants from cached scopes after a failed fetch", () => {
    expect(resolveScopeAccess(failed(true), "terminal:read")).toBe("unreachable");
    expect(resolveScopeAccess(failed(false), "terminal:read")).toBe("unreachable");
    expect(resolveScopeAccess(failed(true, true), "terminal:read")).toBe("pending");
    expect(sessionHasScope(failed(true), "terminal:read")).toBe(false);
  });
});

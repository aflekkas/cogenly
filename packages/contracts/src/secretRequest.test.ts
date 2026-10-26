import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2LoginRequest } from "./orchestrationV2.ts";
import { OrchestratorMcpRequestLoginInput } from "./orchestratorMcp.ts";
import { LoginRequestAnswerInput } from "./secretRequest.ts";

const decodeAnswer = Schema.decodeUnknownSync(LoginRequestAnswerInput);
const decodeLogin = Schema.decodeUnknownSync(OrchestrationV2LoginRequest);
const decodeToolInput = Schema.decodeUnknownSync(OrchestratorMcpRequestLoginInput);

describe("login request contracts", () => {
  it("decodes a save answer with only the typed fields and a decline", () => {
    expect(
      decodeAnswer({
        threadId: "thread:1",
        turnItemId: "turn-item:1",
        answer: { type: "save", username: "ada", password: "fake-pass", keep: true },
      }).answer,
    ).toEqual({ type: "save", username: "ada", password: "fake-pass", keep: true });
    expect(
      decodeAnswer({ threadId: "thread:1", turnItemId: "turn-item:1", answer: { type: "decline" } })
        .answer,
    ).toEqual({ type: "decline" });
  });

  it("requires the keep choice on a save", () => {
    expect(() =>
      decodeAnswer({
        threadId: "thread:1",
        turnItemId: "turn-item:1",
        answer: { type: "save", password: "fake-pass" },
      }),
    ).toThrow();
  });

  it("records the asked site and fields but has no place for a secret", () => {
    const login = decodeLogin({
      origin: "https://github.com",
      fields: ["username", "password", "totp"],
      savedItemId: "vault:1",
      password: "fake-pass",
    });
    expect(login).toEqual({
      origin: "https://github.com",
      fields: ["username", "password", "totp"],
      savedItemId: "vault:1",
    });
    expect(() => decodeLogin({ origin: "https://github.com", fields: ["pin"] })).toThrow();
  });

  it("request_login needs a site and a reason, and at least one field when fields are given", () => {
    expect(decodeToolInput({ site: "github.com", reason: "Open settings." })).toEqual({
      site: "github.com",
      reason: "Open settings.",
    });
    expect(() => decodeToolInput({ site: "github.com" })).toThrow();
    expect(() => decodeToolInput({ site: "github.com", reason: "x", fields: [] })).toThrow();
  });
});

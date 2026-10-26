import { ThreadId, TurnItemId, type OrchestrationV2LoginRequest } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  loginRequestAnswerInput,
  loginRequestDisplay,
  loginRequestDraft,
  loginRequestDraftProblem,
  loginRequestSite,
} from "./secretRequest.ts";

const login: OrchestrationV2LoginRequest = {
  origin: "https://github.com",
  siteName: "GitHub",
  usernameHint: "ada",
  fields: ["username", "password"],
};
const item = {
  id: TurnItemId.make("turn-item:login"),
  threadId: ThreadId.make("thread:1"),
  login,
};

describe("login request card", () => {
  it("starts with the agent's username guess and saving to the vault on", () => {
    expect(loginRequestDraft(login)).toEqual({
      username: "ada",
      password: "",
      totpSecret: "",
      note: "",
      keep: true,
    });
    expect(loginRequestSite(login)).toEqual({ host: "github.com", name: "GitHub" });
    expect(loginRequestSite({ origin: "https://app.example.test:8443" })).toEqual({
      host: "app.example.test",
      name: "app.example.test",
    });
  });

  it("needs a password when it asks for one", () => {
    const draft = loginRequestDraft(login);
    expect(loginRequestDraftProblem(login.fields, draft)).toBe("Enter the password.");
    expect(loginRequestDraftProblem(login.fields, { ...draft, password: "   " })).toBe(
      "Enter the password.",
    );
    expect(loginRequestDraftProblem(login.fields, { ...draft, password: "pw" })).toBeNull();
    expect(loginRequestDraftProblem(["note"], { ...draft, username: "x" })).toBe(
      "Enter the login details.",
    );
    expect(loginRequestAnswerInput(item, { type: "save", draft })).toBeNull();
  });

  it("sends only the typed fields the card asked for", () => {
    const draft = {
      ...loginRequestDraft(login),
      username: "  ada@example.test ",
      password: " fake pass ",
      totpSecret: "JBSWY3DP",
      keep: false,
    };
    expect(loginRequestAnswerInput(item, { type: "save", draft })).toEqual({
      threadId: "thread:1",
      turnItemId: "turn-item:login",
      answer: { type: "save", username: "ada@example.test", password: " fake pass ", keep: false },
    });
    expect(loginRequestAnswerInput(item, { type: "decline" })?.answer).toEqual({
      type: "decline",
    });
  });

  it("shows the form only while pending here, then one line for the outcome", () => {
    expect(loginRequestDisplay({ secretStatus: "pending", login }, "local")).toEqual({
      kind: "pending",
    });
    expect(loginRequestDisplay({ secretStatus: "pending", login }, "inherited").kind).toBe(
      "pending-elsewhere",
    );
    expect(
      loginRequestDisplay(
        { secretStatus: "saved", login: { ...login, savedItemName: "GitHub", kept: true } },
        "local",
      ),
    ).toMatchObject({ outcome: "saved", label: "Saved to your vault as GitHub" });
    expect(
      loginRequestDisplay(
        {
          secretStatus: "saved",
          login: { ...login, updateItemId: "vault:1", savedItemName: "Work GitHub", kept: true },
        },
        "local",
      ),
    ).toMatchObject({ label: "Updated Work GitHub in your vault" });
    expect(
      loginRequestDisplay({ secretStatus: "saved", login: { ...login, kept: false } }, "local"),
    ).toMatchObject({ label: "Used for this task only, not kept" });
    expect(loginRequestDisplay({ secretStatus: "declined", login }, "local")).toMatchObject({
      label: "Skipped",
    });
    // A card nobody needs any more collapses to its outcome; the form is gone.
    expect(loginRequestDisplay({ secretStatus: "cancelled", login }, "local")).toMatchObject({
      kind: "answered",
      outcome: "ended",
    });
  });
});

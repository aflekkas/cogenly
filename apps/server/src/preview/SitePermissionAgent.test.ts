import { describe, expect, it } from "vite-plus/test";

import {
  HeadlessSitePermissions,
  permissionPromptNotice,
  permissionRefusalMessage,
  siteOrigin,
} from "./SitePermissionAgent.ts";

const ORIGIN = "https://app.example.com";

describe("siteOrigin", () => {
  it("keys web pages by origin and ignores everything else", () => {
    expect(siteOrigin("https://app.example.com/photos/smile?x=1")).toBe(ORIGIN);
    expect(siteOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(siteOrigin("about:blank")).toBeNull();
    expect(siteOrigin("not a url")).toBeNull();
  });
});

describe("HeadlessSitePermissions", () => {
  it("grants only what was allowed, per origin", () => {
    const decisions = new HeadlessSitePermissions();
    decisions.set(ORIGIN, "camera", "allow");
    decisions.set(ORIGIN, "microphone", "allow");
    decisions.set("http://localhost:3000", "geolocation", "allow");
    expect(decisions.grants()).toEqual([
      { origin: ORIGIN, permissions: ["camera", "microphone"] },
      { origin: "http://localhost:3000", permissions: ["geolocation"] },
    ]);
  });

  it("treats Block like Ask: nothing is granted, and the state says what was decided", () => {
    const decisions = new HeadlessSitePermissions();
    decisions.set(ORIGIN, "camera", "allow");
    decisions.set(ORIGIN, "camera", "block");
    expect(decisions.grants()).toEqual([]);
    expect(decisions.state(ORIGIN).entries.find((entry) => entry.permission === "camera")).toEqual({
      permission: "camera",
      setting: "block",
      decidedBy: "agent",
    });
    decisions.set(ORIGIN, "camera", "ask");
    expect(decisions.state(ORIGIN).entries.every((entry) => entry.setting === "ask")).toBe(true);
  });

  it("decides camera and microphone separately", () => {
    const decisions = new HeadlessSitePermissions();
    decisions.set(ORIGIN, "microphone", "allow");
    expect(decisions.grants()).toEqual([{ origin: ORIGIN, permissions: ["microphone"] }]);
  });

  it("reports no origin as nothing decided", () => {
    const state = new HeadlessSitePermissions().state(null);
    expect(state.origin).toBeNull();
    expect(state.prompt).toBeNull();
  });
});

describe("permissionPromptNotice", () => {
  const state = (permissions: ReadonlyArray<"camera" | "microphone" | "geolocation">) => ({
    origin: ORIGIN,
    entries: [],
    prompt: permissions.length === 0 ? null : { id: "p1", origin: ORIGIN, permissions },
  });

  it("tells an agent which site waits for what, and what it can do", () => {
    const notice = permissionPromptNotice(state(["camera", "microphone"]));
    expect(notice).toContain(ORIGIN);
    expect(notice).toContain("the camera and the microphone");
    expect(notice).toContain("preview_permission");
  });

  it("says nothing when no page is waiting", () => {
    expect(permissionPromptNotice(state([]))).toBeUndefined();
  });
});

describe("permissionRefusalMessage", () => {
  it("names the user's Block and how to lift it", () => {
    const message = permissionRefusalMessage("user-blocked", "camera", ORIGIN);
    expect(message).toContain("blocked the camera for https://app.example.com");
    expect(message).toContain("Site permissions");
  });

  it("explains a tab with no web page", () => {
    expect(permissionRefusalMessage("no-origin", "camera", null)).toContain("Navigate");
  });
});

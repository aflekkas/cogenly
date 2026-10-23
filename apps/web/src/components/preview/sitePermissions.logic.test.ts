import { describe, expect, it } from "vite-plus/test";

import {
  describeRequestedPermissions,
  siteHost,
  sitePermissionPromptTitle,
  siteSettingSummary,
} from "./sitePermissions.logic";

describe("sitePermissionPromptTitle", () => {
  it("names the site and what it wants", () => {
    expect(
      sitePermissionPromptTitle({
        id: "p",
        origin: "https://app.uat.smileexpress.com",
        permissions: ["camera"],
      }),
    ).toBe("app.uat.smileexpress.com wants to use your camera");
  });

  it("keeps a port in the host so two local dev servers read differently", () => {
    expect(
      sitePermissionPromptTitle({
        id: "p",
        origin: "http://localhost:5173",
        permissions: ["midi"],
      }),
    ).toBe("localhost:5173 wants to use your MIDI devices");
  });
});

describe("describeRequestedPermissions", () => {
  it("reads camera and microphone as one phrase", () => {
    expect(describeRequestedPermissions(["camera", "microphone"])).toBe(
      "use your camera and microphone",
    );
  });

  it("joins different kinds of request", () => {
    expect(describeRequestedPermissions(["geolocation", "notifications"])).toBe(
      "know your location and show notifications",
    );
    expect(describeRequestedPermissions(["camera", "geolocation", "microphone"])).toBe(
      "use your camera and microphone and know your location",
    );
  });
});

describe("site settings labels", () => {
  it("has no host for a tab without a web page", () => {
    expect(siteHost(null)).toBeNull();
    expect(siteHost("https://app.example.com")).toBe("app.example.com");
  });

  it("says when an agent made the decision", () => {
    expect(siteSettingSummary({ permission: "camera", setting: "ask" })).toBe("Ask");
    expect(siteSettingSummary({ permission: "camera", setting: "allow", decidedBy: "user" })).toBe(
      "Allow",
    );
    expect(siteSettingSummary({ permission: "camera", setting: "block", decidedBy: "agent" })).toBe(
      "Block · set by agent",
    );
  });
});

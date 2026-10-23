import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewMachine } from "./previewMachine";

const mac = { label: "Alex's MacBook", machine: "laptop" } as const;
const vps = { label: "My VPS", machine: "cloud" } as const;

const base = {
  runtime: "server" as const,
  threadEnvironment: vps,
  threadIsPrimary: false,
  primaryEnvironment: mac,
  rendersDesktopTabs: true,
  environmentCount: 2,
};

describe("resolvePreviewMachine", () => {
  it("names the remote environment a server tab runs on", () => {
    expect(resolvePreviewMachine(base)).toEqual({
      label: "My VPS",
      machine: "cloud",
      description: "Browser runs on My VPS",
    });
  });

  it("names this computer for a desktop tab, even on a remote thread", () => {
    expect(resolvePreviewMachine({ ...base, runtime: "desktop" })).toMatchObject({
      label: "Alex's MacBook",
      machine: "laptop",
      description: "Browser runs on this computer (Alex's MacBook)",
    });
  });

  it("says this computer for a server tab of the local environment", () => {
    expect(
      resolvePreviewMachine({ ...base, threadEnvironment: mac, threadIsPrimary: true })
        ?.description,
    ).toBe("Browser runs on this computer (Alex's MacBook)");
  });

  it("stays hidden with one environment and a tab running on it", () => {
    expect(resolvePreviewMachine({ ...base, environmentCount: 1 })).toBeNull();
    expect(
      resolvePreviewMachine({
        ...base,
        runtime: "desktop",
        threadEnvironment: mac,
        threadIsPrimary: true,
        environmentCount: 1,
      }),
    ).toBeNull();
  });

  it("names this computer when a desktop app connected only to a VPS shows a desktop tab", () => {
    expect(
      resolvePreviewMachine({
        ...base,
        runtime: "desktop",
        primaryEnvironment: null,
        environmentCount: 1,
      }),
    ).toEqual({
      label: "This computer",
      machine: "laptop",
      description: "Browser runs on this computer",
    });
  });

  it("leaves out desktop tabs a web client cannot show, and tabs not yet open", () => {
    expect(
      resolvePreviewMachine({ ...base, runtime: "desktop", rendersDesktopTabs: false }),
    ).toBeNull();
    expect(resolvePreviewMachine({ ...base, runtime: undefined })).toBeNull();
  });
});

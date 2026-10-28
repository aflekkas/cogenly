import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BrowserExtension,
  BrowserExtensionsListResult,
  type BrowserExtensionLoadState,
} from "./browserExtensions.ts";

const decodeList = Schema.decodeUnknownSync(BrowserExtensionsListResult);
const decodeExtension = Schema.decodeUnknownSync(BrowserExtension);
const encodeExtension = Schema.encodeSync(BrowserExtension);

const legacy = {
  id: "a".repeat(32),
  name: "Legacy",
  version: "1.0",
  description: "",
  manifestVersion: 3,
  enabled: true,
  source: { type: "webStore" },
  permissions: [],
  hostPermissions: [],
  installedAt: "2026-01-01T00:00:00Z",
};

describe("BrowserExtension compatibility", () => {
  it("decodes older servers without toolbar metadata or load state", () => {
    const {
      extensions: [extension],
    } = decodeList({
      profileId: "default",
      extensions: [legacy],
    });
    expect(extension).toMatchObject({ hasAction: false, state: "pending" });
    expect(extension?.icon).toBeUndefined();
    expect(extension?.sidePanelPage).toBeUndefined();
    expectTypeOf<BrowserExtension["hasAction"]>().toEqualTypeOf<boolean>();
    expectTypeOf<BrowserExtension["state"]>().toEqualTypeOf<BrowserExtensionLoadState>();
  });

  it("keeps explicit metadata and all load states on the wire", () => {
    for (const state of ["pending", "installing", "loaded", "failed", "disabled"]) {
      const decoded = decodeExtension({
        ...legacy,
        hasAction: true,
        state,
      });
      expect(decoded.hasAction).toBe(true);
      expect(decoded.state).toBe(state);
      expect(encodeExtension(decoded)).toMatchObject({
        hasAction: true,
        state,
      });
    }
  });
});

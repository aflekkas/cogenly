import { describe, expect, it } from "vite-plus/test";

import { findCreateRequiredPackages } from "./cli-executable-imports.ts";

describe("findCreateRequiredPackages", () => {
  it("finds packages loaded through createRequire handles, inline or named", () => {
    const bundle = `
      import * as NodeModule from "node:module";
      import { createRequire } from "node:module";
      var __require = createRequire(import.meta.url);
      let requireUndici;
      requireUndici = NodeModule.createRequire(import.meta.url);
      const requirePty = NodeModule.createRequire(import.meta.url);
      __require("stream");
      __require("node:sqlite");
      requireUndici("undici");
      requirePty("node-pty/lib/index.js");
      ({ FileFinder } = NodeModule.createRequire(import.meta.url)("@ff-labs/fff-node"));
      // Code generation strings and unrelated functions are not loads.
      const code = \`require("ajv/dist/runtime/validation_error")\`;
      requireCapability("preview");
      requirePty.resolve("@t3tools/shared/fonts/inter.woff2");
    `;
    expect(findCreateRequiredPackages(bundle)).toEqual(["@ff-labs/fff-node", "node-pty", "undici"]);
  });
});

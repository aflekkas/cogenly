import { describe, expect, it } from "@effect/vitest";

import { remoteKeysOf } from "./RepositoryIdentityResolver.ts";

describe("remoteKeysOf", () => {
  it("lists every remote, normalized, once the checkout has more than one", () => {
    expect(
      remoteKeysOf(
        new Map([
          ["origin", "https://smiledoctors.ghe.com/marketing/SmileExpressApp.git"],
          ["spawn", "git@github.com:Spawn-LLC/smile-express.git"],
        ]),
      ),
    ).toEqual([
      "github.com/spawn-llc/smile-express",
      "smiledoctors.ghe.com/marketing/smileexpressapp",
    ]);
  });

  it("leaves a single remote, or two naming the same repository, to the identity itself", () => {
    expect(remoteKeysOf(new Map([["origin", "https://github.com/bartr-app/platform.git"]]))).toBe(
      undefined,
    );
    expect(
      remoteKeysOf(
        new Map([
          ["origin", "https://github.com/bartr-app/platform.git"],
          ["mirror", "git@github.com:bartr-app/platform.git"],
        ]),
      ),
    ).toBe(undefined);
  });
});

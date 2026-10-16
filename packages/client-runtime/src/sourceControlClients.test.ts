import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("sourceControlClients", () => {
  it("reads a missing kind as the first host and an unshipped kind as the generic one", () => {
    expect(sourceControlClients.get(undefined).kind).toBe("github");
    expect(sourceControlClients.get("forkhost").kind).toBe("unknown");
  });

  it("recognizes GitHub URLs and leaves other hosts unsupported", () => {
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("https://github.com/acme/web/pull/7")).toBe("github");
    expect(kindOf("https://git.cafe/acme/web/pulls/7")).toBeUndefined();
    expect(kindOf("https://codeberg.org/acme/web/pulls/7")).toBeUndefined();
  });
});

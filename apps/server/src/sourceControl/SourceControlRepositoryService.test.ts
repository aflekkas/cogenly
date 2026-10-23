import { describe, expect, it } from "@effect/vitest";

import {
  cloneFailureDetail,
  cloneRemoteRejection,
  selectRemoteUrl,
} from "./SourceControlRepositoryService.ts";

const urls = {
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  sshUrl: "git@github.com:acme/widgets.git",
};

describe("selectRemoteUrl", () => {
  it("clones over HTTPS when auto and the provider prefers it", () => {
    expect(selectRemoteUrl(urls, "auto", "https")).toBe(urls.url);
    expect(selectRemoteUrl(urls, undefined, "https")).toBe(urls.url);
  });

  it("keeps SSH for auto without a provider preference", () => {
    expect(selectRemoteUrl(urls, "auto", null)).toBe(urls.sshUrl);
    expect(selectRemoteUrl(urls, "auto", "ssh")).toBe(urls.sshUrl);
  });

  it("honors an explicit protocol over the provider's preference", () => {
    expect(selectRemoteUrl(urls, "ssh", "https")).toBe(urls.sshUrl);
    expect(selectRemoteUrl(urls, "https", "ssh")).toBe(urls.url);
  });
});

describe("cloneRemoteRejection", () => {
  it("allows network remotes for every caller", () => {
    for (const caller of ["owner", "agent"] as const) {
      expect(cloneRemoteRejection("https://github.com/acme/widgets.git", caller)).toBeNull();
      expect(cloneRemoteRejection("http://example.com/acme/widgets.git", caller)).toBeNull();
      expect(cloneRemoteRejection("ssh://git@example.com/acme/widgets.git", caller)).toBeNull();
      expect(cloneRemoteRejection("git://example.com/acme/widgets.git", caller)).toBeNull();
      expect(cloneRemoteRejection("git@github.com:acme/widgets.git", caller)).toBeNull();
    }
  });

  it("refuses option-like and helper-transport remotes for every caller", () => {
    for (const caller of ["owner", "agent"] as const) {
      expect(cloneRemoteRejection("--upload-pack=touch /tmp/pwn", caller)).not.toBeNull();
      expect(cloneRemoteRejection("-oProxyCommand=id", caller)).not.toBeNull();
      expect(cloneRemoteRejection("ext::sh -c id", caller)).not.toBeNull();
      expect(cloneRemoteRejection("fd::17", caller)).not.toBeNull();
    }
  });

  it("allows local remotes only for owner-initiated clones", () => {
    expect(cloneRemoteRejection("/srv/repos/widgets.git", "owner")).toBeNull();
    expect(cloneRemoteRejection("./widgets.git", "owner")).toBeNull();
    expect(cloneRemoteRejection("file:///srv/repos/widgets.git", "owner")).toBeNull();
    expect(cloneRemoteRejection("/srv/repos/widgets.git", "agent")).not.toBeNull();
    expect(cloneRemoteRejection("./widgets.git", "agent")).not.toBeNull();
    expect(cloneRemoteRejection("../widgets.git", "agent")).not.toBeNull();
    expect(cloneRemoteRejection("file:///srv/repos/widgets.git", "agent")).not.toBeNull();
    expect(cloneRemoteRejection("~/widgets.git", "agent")).not.toBeNull();
  });
});

describe("cloneFailureDetail", () => {
  it("says what to do about a refused SSH key and keeps git's words", () => {
    const detail = cloneFailureDetail([
      "git@github.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
    ]);
    expect(detail).toMatch(/^The host refused this machine's SSH key\./);
    expect(detail).toContain("git@github.com: Permission denied (publickey).");
  });

  it("passes other failures through", () => {
    expect(cloneFailureDetail(["fatal: repository not found"])).toBe("fatal: repository not found");
    expect(cloneFailureDetail([])).toBe("The repository could not be cloned.");
  });
});

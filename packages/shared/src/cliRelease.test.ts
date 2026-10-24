import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliExecutableFileName,
  cliReleaseDownloadBaseUrl,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  LEGACY_CLI_EXECUTABLE_NAME,
  legacyCliArchiveFileName,
  newestCliReleaseVersion,
  parseChecksums,
  selectCliArchive,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("names archives by version and platform", () => {
    // The release workflow, the SSH runner, and install.sh spell the same name.
    expect(cliArchiveFileName("1.2.3", "linux-x64")).toBe("cogenly-1.2.3-linux-x64.tar.gz");
    expect(cliArchiveFileName("1.2.3-staging.20260911.4", "linux-arm64")).toBe(
      "cogenly-1.2.3-staging.20260911.4-linux-arm64.tar.gz",
    );
    // What servers and installers from before the rename download.
    expect(legacyCliArchiveFileName("1.2.3", "linux-x64")).toBe("t3-1.2.3-linux-x64.tar.gz");
  });

  it("names the executable, with .exe on Windows", () => {
    expect(cliExecutableFileName("linux")).toBe("cogenly");
    expect(cliExecutableFileName("win32")).toBe("cogenly.exe");
    expect(cliExecutableFileName("linux", LEGACY_CLI_EXECUTABLE_NAME)).toBe("t3");
  });

  it("downloads the cogenly archive and falls back to t3 for releases before the rename", () => {
    const both = parseChecksums(
      [
        `${"a".repeat(64)}  cogenly-1.2.3-linux-x64.tar.gz`,
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"b".repeat(64)}  t3-1.2.3-linux-arm64.tar.gz`,
      ].join("\n"),
    );
    expect(selectCliArchive(both, "1.2.3", "linux-x64")).toEqual({
      fileName: "cogenly-1.2.3-linux-x64.tar.gz",
      sha256: "a".repeat(64),
    });
    expect(selectCliArchive(both, "1.2.3", "linux-arm64")).toEqual({
      fileName: "t3-1.2.3-linux-arm64.tar.gz",
      sha256: "b".repeat(64),
    });
    expect(selectCliArchive(both, "1.2.4", "linux-x64")).toBeUndefined();
  });

  it("only maps platforms and architectures that have a release archive", () => {
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("linux", "arm64")).toBe("linux-arm64");
    // macOS runs the server inside the desktop app; releases ship no CLI archive for it.
    expect(cliArchivePlatformKey("darwin", "arm64")).toBeUndefined();
    expect(cliArchivePlatformKey("win32", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("freebsd", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("resolves download URLs under the tagged Cogenly release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/aflekkas/cogenly/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
      "https://mirror.example/t3/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("derives the release channel from the version alone", () => {
    expect(cliReleaseChannelOf("1.2.3")).toBe("prod");
    expect(cliReleaseChannelOf("1.2.3-staging.20260911.4")).toBe("staging");
    expect(cliReleaseChannelOf("1.2.3-preview.20260911.4")).toBe("prod");
    // Retired or unrelated prerelease trains never imply staging.
    expect(cliReleaseChannelOf("1.2.3-rc.1")).toBe("prod");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-staging.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-staging.20260911.2" },
    ];
    // Retired preview releases cannot appear on either channel.
    expect(newestCliReleaseVersion(releases, "staging")).toBe("1.2.4-staging.20260912.7");
    expect(newestCliReleaseVersion(releases, "prod")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "staging")).toBeUndefined();
  });

  it("pages through the Cogenly release index", () => {
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/aflekkas/cogenly/releases?per_page=100&page=2",
    );
  });
});

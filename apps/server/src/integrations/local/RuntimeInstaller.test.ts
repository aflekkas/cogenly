import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Installer from "./RuntimeInstaller.ts";

/** An installer whose process boundary records commands and answers with `exitCode`. */
const installerWith = (input: {
  readonly platform: NodeJS.Platform;
  readonly brew?: string;
  readonly exitCode?: number;
  readonly fails?: boolean;
}) =>
  Effect.gen(function* () {
    const ran: Array<ReadonlyArray<string>> = [];
    const installer = yield* Installer.make({
      platform: input.platform,
      runner: {
        exists: (path) => Effect.succeed(path === input.brew),
        run: (program, args) =>
          input.fails
            ? Effect.fail(new Installer.InstallerSpawnError({ cause: new Error("spawn ENOENT") }))
            : Effect.sync(() => {
                ran.push([program, ...args]);
                return { exitCode: input.exitCode ?? 0, output: "downloading uv\nerror: no space" };
              }),
      },
    });
    return { installer, ran };
  });

describe("RuntimeInstaller", () => {
  it.effect("uses Homebrew when the machine has it", () =>
    Effect.gen(function* () {
      const { installer, ran } = yield* installerWith({
        platform: "darwin",
        brew: "/usr/local/bin/brew",
      });
      expect(yield* installer.plan("uv")).toMatchObject({
        canInstall: true,
        command: "brew install uv",
      });
      expect(yield* installer.install("uv")).toEqual({
        installed: true,
        message: "uv is installed.",
      });
      expect(ran).toEqual([["/usr/local/bin/brew", "install", "uv"]]);
    }),
  );

  it.effect("falls back to Astral's installer, and to PowerShell's on Windows", () =>
    Effect.gen(function* () {
      const linux = yield* installerWith({ platform: "linux" });
      yield* linux.installer.install("uv");
      expect(linux.ran).toEqual([
        ["/bin/sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
      ]);
      const windows = yield* installerWith({ platform: "win32" });
      expect((yield* windows.installer.plan("uv")).command).toContain("install.ps1");
      yield* windows.installer.install("uv");
      expect(windows.ran[0]?.[0]).toBe("powershell");
    }),
  );

  it.effect("reports a failed install with the command to run by hand", () =>
    Effect.gen(function* () {
      const failed = yield* installerWith({
        platform: "darwin",
        brew: "/opt/homebrew/bin/brew",
        exitCode: 1,
      });
      const result = yield* failed.installer.install("uv");
      expect(result.installed).toBe(false);
      expect(result.message).toContain("Run brew install uv on this machine instead.");
      expect(result.message).toContain("error: no space");

      const unstartable = yield* installerWith({ platform: "darwin", fails: true });
      expect(yield* unstartable.installer.install("uv")).toMatchObject({ installed: false });

      const unsupported = yield* installerWith({ platform: "aix" });
      expect(yield* unsupported.installer.plan("uv")).toMatchObject({ canInstall: false });
      expect(yield* unsupported.installer.install("uv")).toMatchObject({ installed: false });
      expect(unsupported.ran).toHaveLength(0);
    }),
  );

  it("searches uv's install directories", () => {
    expect(Installer.runtimeSearchDirectories("darwin", "/Users/me")).toEqual([
      "/Users/me/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });
});

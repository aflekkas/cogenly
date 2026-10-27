import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Browser from "./PreviewBrowser.ts";
import { previewBrowserCheck } from "../health/healthChecks.ts";

const release: Browser.PreviewBrowserRelease = {
  flavor: "headless-shell",
  version: "test",
  platform: "test",
  url: "https://browser.test/download.zip",
  bytes: 1,
  sha256: "test",
};

it.effect("a fresh home reports install failure and the next attempt retries it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
      }),
    );
    const browser = yield* Browser.makePreviewBrowserInstaller({ baseDir, release }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    expect((yield* browser.status).state).toBe("missing");
    expect(requests).toBe(0);
    const error = yield* Effect.flip(browser.executable);
    expect(error._tag).toBe("PreviewBrowserInstallError");
    const failed = yield* browser.status;
    expect(failed).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("network access"),
    });
    expect(previewBrowserCheck(failed).items[0]).toMatchObject({
      status: "fail",
      fix: "setup-browser",
    });
    yield* Effect.flip(browser.executable);
    expect(requests).toBe(2);
    // A completed install on disk clears the error without another download.
    const executable = path.join(
      baseDir,
      "tools",
      "chrome-headless-shell",
      "test",
      "test",
      (yield* HostProcess.Platform) === "win32"
        ? "chrome-headless-shell.exe"
        : "chrome-headless-shell",
    );
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
    yield* fs.writeFileString(executable, "test");
    yield* fs.chmod(executable, 0o700);
    expect((yield* browser.status).state).toBe("ready");
    expect(yield* browser.executable).toBe(executable);
    expect(requests).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a slow first download reports progress and continues after the caller stops waiting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const downloading = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const http = HttpClient.make((request) =>
        Deferred.succeed(downloading, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
        ),
      );
      const browser = yield* Browser.makePreviewBrowserInstaller({
        baseDir,
        release,
        wait: "1 second",
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const opening = yield* browser.executable.pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(downloading);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PreviewBrowserInstallingError" },
      });
      expect((yield* browser.status).state).toBe("installing");
      expect(previewBrowserCheck(yield* browser.status).items[0]?.detail).toContain("installing");
      yield* Deferred.succeed(finish, undefined);
      yield* Effect.flip(browser.executable);
      expect((yield* browser.status).state).toBe("failed");
    }).pipe(Effect.provide(NodeServices.layer)),
);

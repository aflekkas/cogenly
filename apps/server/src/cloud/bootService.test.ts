import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { parseServiceState } from "./serviceProtocol.ts";
import { describe, expect, it } from "@effect/vitest";

import {
  bootServiceBaseDirOf,
  bootServicePath,
  renderBootServicePlist,
  renderBootServiceUnit,
  type BootServicePlan,
} from "./bootService.ts";

const plan: BootServicePlan = {
  program: ["/home/owner/.cogenly/runtime/versions/0.1.0/cogenly", "__service-launcher"],
  baseDir: "/home/owner/.cogenly",
  logPath: "/home/owner/.cogenly/userdata/logs/boot-service.log",
  unitPath: "/home/owner/.config/systemd/user/cogenly.service",
};

describe("boot service unit renderer", () => {
  it("renders a restarting user service", () => {
    const unit = renderBootServiceUnit(plan);
    expect(unit).toContain("Description=Cogenly server\n");
    expect(unit).toContain("Type=notify\n");
    expect(unit).toContain("NotifyAccess=all\n");
    expect(unit).toContain("WatchdogSec=60\n");
    expect(unit).toContain("TimeoutStartSec=180\n");
    expect(unit).toContain("TimeoutStopSec=30\n");
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("RestartSec=5\n");
    expect(unit).toContain(
      "ExecStart=/home/owner/.cogenly/runtime/versions/0.1.0/cogenly __service-launcher\n",
    );
    expect(unit).toContain("Environment=COGENLY_HOME=/home/owner/.cogenly\n");
    expect(unit).toContain(
      "StandardOutput=append:/home/owner/.cogenly/userdata/logs/boot-service.log\n",
    );
    expect(unit).toContain(
      "StandardError=append:/home/owner/.cogenly/userdata/logs/boot-service.log\n",
    );
    expect(unit).toContain("WantedBy=default.target\n");
    expect(unit).not.toContain("COGENLY_TZ");
  });

  it("keeps systemd's own WorkingDirectory specifier while escaping values", () => {
    const unit = renderBootServiceUnit({
      ...plan,
      baseDir: "/home/owner/my 100% dir",
      logPath: "/home/owner/my 100% dir/boot-service.log",
    });
    expect(unit).toContain("WorkingDirectory=%h\n");
    expect(unit).toContain('Environment=COGENLY_HOME="/home/owner/my 100%% dir"\n');
    expect(unit).toContain("StandardOutput=append:/home/owner/my 100%% dir/boot-service.log\n");
  });

  it("gives the server a PATH that finds provider CLIs without a login shell", () => {
    const unit = renderBootServiceUnit(plan, {
      environmentPath: bootServicePath({
        installerPath: "/usr/bin:/bin",
        execDir: "/home/owner/.cogenly/runtime/versions/0.1.0",
        homeDir: "/home/owner",
      }),
    });
    const pathLine = /^Environment=PATH=(.*)$/m.exec(unit)?.[1]?.split(":") ?? [];
    // claude's installer, npm -g with a user prefix (codex), bun, and the system gh.
    for (const directory of [
      "/home/owner/.local/bin",
      "/home/owner/.npm-global/bin",
      "/home/owner/.bun/bin",
      "/usr/bin",
    ]) {
      expect(pathLine).toContain(directory);
    }
    // The installing shell keeps precedence, and nothing repeats.
    expect(pathLine.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(new Set(pathLine).size).toBe(pathLine.length);
    expect(renderBootServiceUnit(plan)).not.toContain("Environment=PATH=");
  });

  it("drops installer PATH entries a service file cannot carry", () => {
    expect(
      bootServicePath({ installerPath: "/ok:/bad\u0001dir::", execDir: "/exec", homeDir: "" })
        .split(":")
        .slice(0, 2),
    ).toEqual(["/ok", "/exec"]);
  });

  it("bakes the schedule zone into the unit when configured", () => {
    const unit = renderBootServiceUnit({ ...plan, timeZone: "America/New_York" });
    expect(unit).toContain("Environment=COGENLY_TZ=America/New_York\n");
  });
});

describe("boot service plist renderer", () => {
  const options = { homeDir: "/Users/owner", environmentPath: "/usr/bin:/bin" };

  it("renders a launch agent that starts at load and stays alive", () => {
    const plist = renderBootServicePlist(plan, options);
    expect(plist).toContain("<string>com.cogenly.app.service</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
    expect(plist).toContain("<string>/home/owner/.cogenly/runtime/versions/0.1.0/cogenly</string>");
    expect(plist).toContain("<string>__service-launcher</string>");
    expect(plist).toContain("<key>COGENLY_HOME</key>\n    <string>/home/owner/.cogenly</string>");
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/home/owner/.cogenly/userdata/logs/boot-service.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/home/owner/.cogenly/userdata/logs/boot-service.log</string>",
    );
    expect(plist).not.toContain("COGENLY_TZ");
  });

  it("bakes the schedule zone into the plist when configured", () => {
    const plist = renderBootServicePlist({ ...plan, timeZone: "UTC" }, options);
    expect(plist).toContain("<key>COGENLY_TZ</key>\n    <string>UTC</string>");
  });

  it("escapes XML text in paths", () => {
    const plist = renderBootServicePlist(
      { ...plan, baseDir: "/home/a&b/<c>" },
      { homeDir: "/Users/a&b", environmentPath: "/usr/bin" },
    );
    expect(plist).toContain("<string>/home/a&amp;b/&lt;c&gt;</string>");
    expect(plist).toContain("<string>/Users/a&amp;b</string>");
    expect(plist).not.toContain("a&b");
  });
});

describe("bootServiceBaseDirOf", () => {
  it("reads COGENLY_HOME back out of a systemd unit", () => {
    expect(bootServiceBaseDirOf(renderBootServiceUnit(plan))).toBe("/home/owner/.cogenly");
    expect(
      bootServiceBaseDirOf(renderBootServiceUnit({ ...plan, baseDir: "/home/owner/my 100% dir" })),
    ).toBe("/home/owner/my 100% dir");
  });

  it("reads COGENLY_HOME back out of a plist", () => {
    expect(
      bootServiceBaseDirOf(
        renderBootServicePlist(plan, { homeDir: "/Users/owner", environmentPath: "/usr/bin" }),
      ),
    ).toBe("/home/owner/.cogenly");
    expect(
      bootServiceBaseDirOf(
        renderBootServicePlist(
          { ...plan, baseDir: "/home/a&b" },
          { homeDir: "/Users/owner", environmentPath: "/usr/bin" },
        ),
      ),
    ).toBe("/home/a&b");
  });

  it("returns undefined when no home is recorded", () => {
    expect(bootServiceBaseDirOf("[Service]\nExecStart=/bin/true\n")).toBeUndefined();
  });
});

it.effect.each([true, false])(
  "stages an installed service update for a trial (start=%s)",
  (start) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-service-trial-" });
      const baseDir = path.join(root, "home");
      const runtime = path.join(baseDir, "runtime/versions/0.3.3");
      const unit = path.join(root, ".config/systemd/user/cogenly.service");
      const stateFile = path.join(baseDir, "runtime/service-state.json");
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.writeFileString(path.join(runtime, "cogenly"), "");
      yield* fs.writeFileString(path.join(runtime, ".install-complete"), "0.3.3");
      yield* fs.makeDirectory(path.dirname(unit), { recursive: true });
      yield* fs.writeFileString(unit, "old unit");
      yield* fs.writeFileString(stateFile, JSON.stringify({ protocol: 3, activeVersion: "0.3.2" }));
      const commands: string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* BootService.make({
          baseDir,
          logsDir: path.join(root, "logs"),
          cliVersion: "0.3.3",
        });
        yield* service.install({
          start,
          trialDatabasePath: path.join(baseDir, "userdata/statev2.sqlite"),
        });
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ HOME: root, PATH: "" }),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 1000),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Environment, { HOME: root, PATH: "" }),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) => {
              commands.push(input.args.join(" "));
              return Effect.succeed({
                code: ChildProcessSpawner.ExitCode(0),
                stdout: input.args.includes("--version")
                  ? "cogenly v0.3.3"
                  : input.command === "loginctl"
                    ? "yes"
                    : "",
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      );
      expect(parseServiceState(yield* fs.readFileString(stateFile))).toMatchObject({
        activeVersion: "0.3.2",
        update: { fromVersion: "0.3.2", targetVersion: "0.3.3", status: "pending" },
      });
      expect(commands.some((command) => command.includes("stop"))).toBe(start);
      expect(yield* fs.readFileString(unit)).toContain("0.3.3");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const successfulProcess = (stdout = ""): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const serviceTestRuntime = (root: string, runner: ProcessRunner.ProcessRunner["Service"]) =>
  Layer.mergeAll(
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ HOME: root, PATH: "" }),
    ),
    Layer.succeed(HostProcess.Platform, "linux" as const),
    Layer.succeed(HostProcess.UserId, 1000),
    Layer.succeed(HostProcess.IsExecutable, true),
    Layer.succeed(HostProcess.Environment, { HOME: root, PATH: "" }),
    Layer.succeed(ProcessRunner.ProcessRunner, runner),
    FetchHttpClient.layer,
  );

const installedServiceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-service-status-" });
  const baseDir = path.join(root, "home");
  const runtime = path.join(baseDir, "runtime/versions/0.3.7");
  const unitPath = path.join(root, ".config/systemd/user/cogenly.service");
  const logPath = path.join(root, "logs/boot-service.log");
  yield* fs.makeDirectory(runtime, { recursive: true });
  yield* fs.writeFileString(path.join(runtime, "cogenly"), "");
  yield* fs.writeFileString(path.join(runtime, ".install-complete"), "0.3.7");
  yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
  yield* fs.writeFileString(
    unitPath,
    renderBootServiceUnit(
      {
        program: [path.join(runtime, "cogenly"), "__service-launcher"],
        baseDir,
        unitPath,
        logPath,
      },
      { environmentPath: "/usr/bin:/bin" },
    ),
  );
  return {
    fs,
    path,
    root,
    baseDir,
    logPath,
    stateFile: path.join(baseDir, "runtime/service-state.json"),
    marker: path.join(baseDir, "runtime/.restart-pending"),
  };
});

it.effect.each([
  { activeVersion: "0.3.6", status: "pending", marker: "0.3.7", expected: true },
  { activeVersion: "0.3.7", status: "committed", marker: "0.3.7", expected: false },
  { activeVersion: "0.3.6", status: "rolled-back", marker: "0.3.7", expected: true },
  { activeVersion: "0.3.7", status: "committed", marker: "0.3.8", expected: true },
  { activeVersion: "0.3.7", status: undefined, marker: "0.3.7", expected: true },
])("computes deferred restart status from the committed target: %j", (scenario) =>
  Effect.gen(function* () {
    const { fs, path, root, baseDir, logPath, stateFile, marker } = yield* installedServiceFixture;
    yield* fs.writeFileString(
      stateFile,
      JSON.stringify({
        protocol: 3,
        activeVersion: scenario.activeVersion,
        ...(scenario.status === undefined
          ? {}
          : {
              update: {
                id: "update",
                fromVersion: "0.3.6",
                targetVersion: "0.3.7",
                status: scenario.status,
                ...(scenario.status === "pending"
                  ? { dbPath: path.join(baseDir, "userdata/statev2.sqlite") }
                  : {}),
              },
            }),
      }),
    );
    yield* fs.writeFileString(marker, `${scenario.marker}\n`);
    const result = yield* Effect.gen(function* () {
      const service = yield* BootService.make({
        baseDir,
        logsDir: path.dirname(logPath),
        cliVersion: "0.3.7",
      });
      return yield* service.status;
    }).pipe(
      Effect.provide(
        serviceTestRuntime(root, {
          run: (input) =>
            Effect.succeed(
              successfulProcess(input.args.includes("is-enabled") ? "enabled" : "yes"),
            ),
        }),
      ),
    );
    expect(result.problems?.includes("restart-pending")).toBe(scenario.expected);
    expect(result.current).toBe(!scenario.expected);
    // Status is read-only, even when it recognizes a stale marker.
    expect(yield* fs.exists(marker)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("waits for a healthy startup longer than 60 seconds without starting recovery", () =>
  Effect.gen(function* () {
    const { path, root, baseDir, logPath } = yield* installedServiceFixture;
    const starting = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    let starts = 0;
    const restart = Effect.gen(function* () {
      const service = yield* BootService.make({
        baseDir,
        logsDir: path.dirname(logPath),
        cliVersion: "0.3.7",
      });
      return yield* service.restart;
    }).pipe(
      Effect.provide(
        serviceTestRuntime(root, {
          run: (input) => {
            if (!input.args.includes("restart")) return Effect.succeed(successfulProcess());
            starts++;
            // Model the external process with the same timeout the real runner applies.
            return Deferred.succeed(starting, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
              Effect.as(successfulProcess()),
              Effect.timeout(input.timeout ?? Duration.seconds(60)),
              Effect.orDie,
            );
          },
        }),
      ),
    );
    const fiber = yield* Effect.forkChild(restart);
    yield* Deferred.await(starting);
    yield* TestClock.adjust("90 seconds");
    yield* Deferred.succeed(ready, undefined);
    expect(yield* Fiber.join(fiber)).toBe(true);
    expect(starts).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

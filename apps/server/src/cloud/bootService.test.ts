import { describe, expect, it } from "@effect/vitest";

import {
  bootServiceBaseDirOf,
  bootServicePath,
  renderBootServicePlist,
  renderBootServiceUnit,
  type BootServicePlan,
} from "./bootService.ts";

const plan: BootServicePlan = {
  program: ["/home/owner/.cogenly/runtime/versions/0.1.0/t3", "__service-launcher"],
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
      "ExecStart=/home/owner/.cogenly/runtime/versions/0.1.0/t3 __service-launcher\n",
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
    expect(plist).toContain("<string>/home/owner/.cogenly/runtime/versions/0.1.0/t3</string>");
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

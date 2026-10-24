import { assert, describe, it } from "@effect/vitest";

import type * as BootService from "../cloud/bootService.ts";
import { parseServeDropIn, serveMigrationBlocker } from "./doctorTailscale.ts";

describe("Tailscale Serve drop-ins", () => {
  it("recognizes the drop-in that turns Serve on, and nothing else in it", () => {
    assert.deepEqual(parseServeDropIn("[Service]\nEnvironment=COGENLY_TAILSCALE_SERVE=1\n"), {
      enabled: true,
      servePort: null,
      onlyServe: true,
    });
  });

  it("reads the port and keeps a drop-in that sets other things", () => {
    assert.deepEqual(
      parseServeDropIn(
        '[Service]\nEnvironment="COGENLY_TAILSCALE_SERVE=true"\nEnvironment=COGENLY_TAILSCALE_SERVE_PORT=8443\nEnvironment=COGENLY_TZ=UTC\n',
      ),
      { enabled: true, servePort: 8443, onlyServe: false },
    );
  });

  it("reads a drop-in that sets only the port, so the port survives the move", () => {
    assert.deepEqual(
      parseServeDropIn("[Service]\nEnvironment=COGENLY_TAILSCALE_SERVE_PORT=10000\n"),
      { enabled: null, servePort: 10000, onlyServe: true },
    );
  });

  it("ignores drop-ins that do not mention Serve", () => {
    assert.isNull(parseServeDropIn("[Service]\nEnvironment=COGENLY_TZ=UTC\n"));
  });
});

describe("moving the Serve setting out of a drop-in", () => {
  const installed: BootService.BootServiceStatus = {
    supported: true,
    installed: true,
    current: true,
    installedVersion: "0.3.0",
    installedBaseDir: "/home/alex/.cogenly",
    unitPath: "/home/alex/.config/systemd/user/cogenly.service",
    logPath: "/home/alex/.cogenly/logs/service.log",
  };
  const context = { baseDir: "/home/alex/.cogenly", cliVersion: "0.3.0" };
  const resolve = (path: string) => path.replace(/\/+$/u, "");

  it("goes ahead when the service serves this home on this release", () => {
    assert.isNull(serveMigrationBlocker(installed, context, resolve));
    assert.isNull(
      serveMigrationBlocker(
        { ...installed, installedBaseDir: "/home/alex/.cogenly/" },
        context,
        resolve,
      ),
    );
  });

  it("leaves the drop-in when the service would start without reading the setting", () => {
    assert.include(
      serveMigrationBlocker({ ...installed, installedVersion: "0.2.0" }, context, resolve),
      "cogenly service install",
    );
    assert.include(
      serveMigrationBlocker({ ...installed, installedBaseDir: "/srv/cogenly" }, context, resolve),
      "/srv/cogenly",
    );
    assert.include(
      serveMigrationBlocker({ ...installed, installed: false }, context, resolve),
      "isn't installed",
    );
  });
});

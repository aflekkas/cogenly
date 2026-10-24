import { assert, describe, it } from "@effect/vitest";

import { parseServeDropIn } from "./doctorTailscale.ts";

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

  it("ignores drop-ins that do not mention Serve", () => {
    assert.isNull(parseServeDropIn("[Service]\nEnvironment=COGENLY_TZ=UTC\n"));
  });
});

import { assert, describe, it } from "@effect/vitest";
import type { MachineSetupStatus, MachineSetupStepId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildMachineSetupStatus,
  emptyProgress,
  type MachineSetupObservation,
  planStep,
  TAILSCALE_INSTALL_SCRIPT,
} from "./machineSetupSteps.ts";
import type { TailscaleStatusSnapshot } from "./tailscaleState.ts";

const now = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");

const signedIn: TailscaleStatusSnapshot = {
  backendState: "Running",
  authUrl: null,
  magicDnsName: "hub.tail1234.ts.net",
  tailnetName: "alex@example.com",
  httpsEnabled: true,
};

const observation = (
  overrides: Partial<MachineSetupObservation> = {},
): MachineSetupObservation => ({
  machineName: "MacBook",
  host: { platform: "darwin", root: false, passwordlessSudo: false, homebrew: false },
  installed: true,
  version: "1.90.1",
  status: signedIn,
  serveMappings: [],
  localPort: 3773,
  serveMode: { enabled: false, servePort: 443 },
  progress: emptyProgress,
  ...overrides,
});

const stepOf = (status: MachineSetupStatus, id: MachineSetupStepId) =>
  status.steps.find((step) => step.id === id)!;

describe("machine setup checklist", () => {
  it("explains Tailscale and installs it on Linux with passwordless sudo", () => {
    const status = buildMachineSetupStatus(
      observation({
        machineName: "VPS",
        host: { platform: "linux", root: false, passwordlessSudo: true, homebrew: false },
        installed: false,
        version: null,
        status: null,
        serveMappings: null,
      }),
      now,
    );
    const install = stepOf(status, "install");
    assert.equal(install.state, "todo");
    assert.equal(install.action, "Install Tailscale");
    assert.include(install.detail, "private, encrypted link");
    assert.equal(stepOf(status, "start").state, "blocked");
    assert.isFalse(status.ready);
  });

  it("hands Linux installs without sudo to a terminal, never asking for the password", () => {
    const status = buildMachineSetupStatus(
      observation({
        machineName: "VPS",
        host: { platform: "linux", root: false, passwordlessSudo: false, homebrew: false },
        installed: false,
        status: null,
      }),
      now,
    );
    const install = stepOf(status, "install");
    assert.isNull(install.action);
    assert.deepEqual(install.handoff, {
      _tag: "run-command",
      command: TAILSCALE_INSTALL_SCRIPT,
      reason: "Run this in a terminal on VPS. It asks for your password.",
    });
  });

  it("opens the App Store on a Mac, and offers the download link to other browsers", () => {
    const status = buildMachineSetupStatus(observation({ installed: false, status: null }), now);
    const install = stepOf(status, "install");
    assert.equal(install.action, "Open the App Store");
    assert.equal(install.handoff?._tag, "open-url");
    assert.equal(
      planStep("install", observation({ installed: false, status: null })),
      "open-app-store",
    );
  });

  it("says Tailscale isn't running on a Mac that slept, with one fix", () => {
    const status = buildMachineSetupStatus(observation({ status: null }), now);
    const start = stepOf(status, "start");
    assert.equal(start.state, "todo");
    assert.include(start.detail, "Tailscale isn't running on MacBook");
    assert.equal(start.action, "Open Tailscale");
    assert.equal(stepOf(status, "sign-in").state, "blocked");
  });

  it("waits on a sign-in page and leaves the rest blocked", () => {
    const status = buildMachineSetupStatus(
      observation({
        status: { ...signedIn, backendState: "NeedsLogin", httpsEnabled: null },
        progress: { ...emptyProgress, loginUrl: "https://login.tailscale.com/a/abc" },
      }),
      now,
    );
    const signIn = stepOf(status, "sign-in");
    assert.equal(signIn.state, "waiting");
    assert.deepEqual(signIn.handoff, {
      _tag: "open-url",
      url: "https://login.tailscale.com/a/abc",
      label: "Sign in to Tailscale",
    });
    assert.equal(stepOf(status, "expose").state, "blocked");
  });

  it("shows the tailnet's HTTPS approval link while Serve waits for it", () => {
    const status = buildMachineSetupStatus(
      observation({
        status: { ...signedIn, httpsEnabled: false },
        progress: {
          ...emptyProgress,
          serveApprovalUrl: "https://login.tailscale.com/f/serve?node=n1",
        },
      }),
      now,
    );
    const https = stepOf(status, "enable-https");
    assert.equal(https.state, "waiting");
    assert.equal(
      https.handoff?._tag === "open-url" && https.handoff.url,
      "https://login.tailscale.com/f/serve?node=n1",
    );
    assert.equal(stepOf(status, "expose").state, "waiting");
  });

  it("is ready once Serve fronts this server and Cogenly accepts it", () => {
    const status = buildMachineSetupStatus(
      observation({
        serveMappings: [{ port: 443, target: "http://127.0.0.1:3773", funnel: false }],
        serveMode: { enabled: true, servePort: 443 },
      }),
      now,
    );
    assert.isTrue(status.ready);
    assert.isTrue(status.tailscale.served);
    assert.equal(status.joinUrl, "https://hub.tail1234.ts.net/");
  });

  it("never treats a Funnel mapping as private", () => {
    const status = buildMachineSetupStatus(
      observation({
        serveMappings: [{ port: 443, target: "http://127.0.0.1:3773", funnel: true }],
        serveMode: { enabled: true, servePort: 443 },
      }),
      now,
    );
    assert.isFalse(status.ready);
    assert.isNull(status.joinUrl);
    assert.include(stepOf(status, "expose").detail, "public internet");
  });

  it("plans turning Serve off only once signed in", () => {
    assert.equal(planStep("disable-expose", observation()), "serve-off");
    assert.isNull(
      planStep(
        "disable-expose",
        observation({ status: { ...signedIn, backendState: "NeedsLogin", httpsEnabled: null } }),
      ),
    );
  });

  it("switches a refused step to the command that needs the user's password", () => {
    const refused = observation({
      machineName: "VPS",
      host: { platform: "linux", root: false, passwordlessSudo: false, homebrew: false },
      status: { ...signedIn, httpsEnabled: true },
      progress: { ...emptyProgress, needsPassword: new Set(["expose"]) },
    });
    const expose = stepOf(buildMachineSetupStatus(refused, now), "expose");
    assert.isNull(expose.action);
    assert.equal(
      expose.handoff?._tag === "run-command" && expose.handoff.command,
      "sudo tailscale set --operator=$USER",
    );
    assert.isNull(planStep("expose", refused));
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  classifyLinuxSandboxFailure,
  detectSandboxPackageManager,
  sandboxInstallCommand,
  sandboxInstallCommands,
} from "./sandboxProvisioning.ts";

describe("distro bubblewrap provisioning", () => {
  it.each([
    [
      "apt-get",
      "sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap",
    ],
    ["dnf", "sudo dnf install -y bubblewrap"],
    ["pacman", "sudo pacman -S --needed --noconfirm bubblewrap"],
    ["zypper", "sudo zypper --non-interactive install bubblewrap"],
    ["apk", "sudo apk add --no-cache bubblewrap"],
  ])("detects %s and generates its non-interactive command", (binary, expected) => {
    const manager = detectSandboxPackageManager([binary]);
    expect(manager).not.toBeNull();
    expect(sandboxInstallCommand(manager!, false)).toBe(expected);
    expect(sandboxInstallCommand(manager!, true)).toBe(expected.replaceAll("sudo ", ""));
    expect(sandboxInstallCommands(manager!).flat()).toContain("bubblewrap");
  });
  it("prefers the native supported manager and handles unknown hosts", () => {
    expect(detectSandboxPackageManager(["dnf", "apt-get", "apk"])).toBe("apt-get");
    expect(detectSandboxPackageManager(["brew"])).toBeNull();
  });
});

describe("bubblewrap probe output fixtures", () => {
  it.each([
    ["bwrap: Creating new namespace failed: Operation not permitted", true, "apparmor-userns"],
    ["bwrap: setting up uid map: Permission denied", true, "apparmor-userns"],
    [
      "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces",
      false,
      "userns-blocked",
    ],
    ["bwrap: Creating new namespace failed: Operation not permitted", false, "userns-blocked"],
    ["bwrap: prctl(PR_SET_SECCOMP): Invalid argument", true, "seccomp-unsupported"],
    ["bwrap: seccomp not supported", false, "seccomp-unsupported"],
    ["bwrap: unknown option --disable-userns", false, "probe-failed"],
    ["", false, "probe-failed"],
  ] as const)("classifies %s", (output, appArmor, expected) => {
    expect(classifyLinuxSandboxFailure(output, appArmor)).toBe(expected);
  });
});

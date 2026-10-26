import { describe, expect, it } from "vite-plus/test";
import {
  apparmorBwrapProfile,
  apparmorBwrapProfilePath,
  apparmorProfileInstallCommand,
  apparmorProfileInstallCommands,
  classifyLinuxSandboxFailure,
  detectSandboxPackageManager,
  isAppArmorUsernsRestricted,
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
    ["bwrap: unknown option --disable-userns", true, "probe-failed"],
    ["", true, "probe-failed"],
    ["", false, "probe-failed"],
  ] as const)("classifies %s", (output, appArmor, expected) => {
    expect(classifyLinuxSandboxFailure(output, appArmor)).toBe(expected);
  });
});

describe("AppArmor userns restriction", () => {
  it.each([
    ["1", true],
    ["1\n", true],
    ["0", false],
    ["", false],
    [null, false],
    [undefined, false],
  ] as const)("sysctl %j restricted=%s", (value, expected) => {
    expect(isAppArmorUsernsRestricted(value)).toBe(expected);
  });

  it("generates a profile scoped to the bwrap binary with flags=(unconfined) and userns", () => {
    const profile = apparmorBwrapProfile("/usr/bin/bwrap");
    expect(profile).toContain("abi <abi/4.0>,");
    expect(profile).toContain("profile /usr/bin/bwrap flags=(unconfined) {");
    expect(profile).toContain("  userns,\n}");
    expect(profile).not.toContain("apparmor_restrict_unprivileged_userns=0");
    expect(profile).not.toContain("sysctl");
    expect(apparmorBwrapProfile("/bin/bwrap")).toContain("profile /bin/bwrap flags=(unconfined) {");
  });

  it("install commands write and reload only the cogenly-bwrap profile", () => {
    expect(apparmorBwrapProfilePath).toBe("/etc/apparmor.d/cogenly-bwrap");
    expect(apparmorProfileInstallCommands()).toEqual([
      ["tee", "/etc/apparmor.d/cogenly-bwrap"],
      ["apparmor_parser", "-r", "/etc/apparmor.d/cogenly-bwrap"],
    ]);
  });

  it("no-sudo output is the exact sudo tee heredoc plus parser reload", () => {
    const command = apparmorProfileInstallCommand("/usr/bin/bwrap", false);
    expect(command).toBe(
      "sudo tee /etc/apparmor.d/cogenly-bwrap >/dev/null <<'EOF'\n" +
        apparmorBwrapProfile("/usr/bin/bwrap") +
        "EOF\n" +
        "sudo apparmor_parser -r /etc/apparmor.d/cogenly-bwrap",
    );
    expect(command).toContain("profile /usr/bin/bwrap flags=(unconfined) {");
    expect(command).not.toContain("apparmor_restrict_unprivileged_userns=0");
  });

  it("root output drops sudo", () => {
    const command = apparmorProfileInstallCommand("/usr/bin/bwrap", true);
    expect(command.startsWith("tee /etc/apparmor.d/cogenly-bwrap")).toBe(true);
    expect(command).not.toContain("sudo");
    expect(command.endsWith("apparmor_parser -r /etc/apparmor.d/cogenly-bwrap")).toBe(true);
  });
});

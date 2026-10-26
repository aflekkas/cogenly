/** Use the distro binary: Ubuntu's AppArmor exception is tied to its installed path. */
const packageManagers = ["apt-get", "dnf", "pacman", "zypper", "apk"] as const;
type PackageManager = (typeof packageManagers)[number];

export const detectSandboxPackageManager = (available: ReadonlyArray<string>) =>
  packageManagers.find((manager) => available.includes(manager)) ?? null;

export const sandboxInstallCommands = (manager: PackageManager) => {
  switch (manager) {
    case "apt-get":
      return [
        ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update"],
        ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "bubblewrap"],
      ];
    case "dnf":
      return [["dnf", "install", "-y", "bubblewrap"]];
    case "pacman":
      return [["pacman", "-S", "--needed", "--noconfirm", "bubblewrap"]];
    case "zypper":
      return [["zypper", "--non-interactive", "install", "bubblewrap"]];
    case "apk":
      return [["apk", "add", "--no-cache", "bubblewrap"]];
  }
};

export const sandboxInstallCommand = (manager: PackageManager, root: boolean) =>
  sandboxInstallCommands(manager)
    .map((args) => `${root ? "" : "sudo "}${args.join(" ")}`)
    .join(" && ");

/** Where Ubuntu reads the per-program AppArmor exception for bubblewrap. */
export const apparmorBwrapProfilePath = "/etc/apparmor.d/cogenly-bwrap";

export const apparmorUsernsSysctlPath = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** True only when `kernel.apparmor_restrict_unprivileged_userns` is exactly on. */
export const isAppArmorUsernsRestricted = (sysctlValue: string | null | undefined): boolean =>
  sysctlValue?.trim() === "1";

/**
 * Ubuntu 24.04's documented per-program `userns` exception: an unconfined
 * profile scoped to the one binary, leaving the global restriction on.
 */
export const apparmorBwrapProfile = (bwrapPath: string) =>
  `# Allow bubblewrap (only) to create unprivileged user namespaces on Ubuntu 24.04.\n` +
  `# The global kernel.apparmor_restrict_unprivileged_userns restriction stays enabled.\n` +
  `abi <abi/4.0>,\n` +
  `include <tunables/global>\n` +
  `\n` +
  `profile ${bwrapPath} flags=(unconfined) {\n` +
  `  userns,\n` +
  `}\n`;

/** Privileged steps to install and load the profile, without sudo prefixes. */
export const apparmorProfileInstallCommands = () =>
  [
    ["tee", apparmorBwrapProfilePath],
    ["apparmor_parser", "-r", apparmorBwrapProfilePath],
  ] as const;

/** The exact commands to run by hand when root/passwordless sudo is unavailable. */
export const apparmorProfileInstallCommand = (bwrapPath: string, root: boolean) => {
  const prefix = root ? "" : "sudo ";
  return (
    `${prefix}tee ${apparmorBwrapProfilePath} >/dev/null <<'EOF'\n` +
    apparmorBwrapProfile(bwrapPath) +
    `EOF\n` +
    `${prefix}apparmor_parser -r ${apparmorBwrapProfilePath}`
  );
};

export type SandboxFailure =
  | "sandbox-exec-failed"
  | "bwrap-missing"
  | "apparmor-userns"
  | "userns-blocked"
  | "seccomp-unsupported"
  | "architecture-unsupported"
  | "probe-failed"
  | "platform-unsupported";

export const classifyLinuxSandboxFailure = (
  output: string,
  appArmorRestricted: boolean,
): SandboxFailure => {
  if (/seccomp|filter.*(?:invalid|unsupported)|prctl.*(?:invalid|not supported)/i.test(output))
    return "seccomp-unsupported";
  if (/namespace|unshare|uid map|gid map|apparmor/i.test(output))
    return appArmorRestricted ? "apparmor-userns" : "userns-blocked";
  return "probe-failed";
};

export const sandboxFailureReason = (failure: SandboxFailure) => {
  switch (failure) {
    case "sandbox-exec-failed":
      return "sandbox-exec failed its read-only sandbox probe";
    case "bwrap-missing":
      return "bubblewrap isn't installed";
    case "apparmor-userns":
      return "bubblewrap is blocked by AppArmor user-namespace restriction";
    case "userns-blocked":
      return "bubblewrap user namespaces are blocked by the host";
    case "seccomp-unsupported":
      return "the host does not support the required seccomp filter";
    case "architecture-unsupported":
      return "the read-only sandbox does not support this Linux architecture";
    case "platform-unsupported":
      return "read-only chat terminals are supported only on macOS and Linux";
    case "probe-failed":
      return "the read-only sandbox confinement probe failed";
  }
};

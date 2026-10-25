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

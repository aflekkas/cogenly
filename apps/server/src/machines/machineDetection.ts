/**
 * Best-effort guesses about what kind of machine this server runs on, for the
 * Machines list. Every probe may fail; a failed probe means "no signal", and
 * the user can override the result in the machine settings RPC.
 */
import type {
  EnvironmentMachineKind,
  ExecutionEnvironmentPlatformOs,
  MachineHardware,
  MachineRole,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";

export interface MachineFacts {
  readonly role: MachineRole;
  readonly hardware: MachineHardware;
  /** The hosting company, when the host gives it away. */
  readonly hostingProvider: string | null;
}

// Matched against DMI vendor/product strings, the host name, and reverse DNS.
const HOSTING_PROVIDERS: ReadonlyArray<readonly [marker: string, name: string]> = [
  ["contabo", "Contabo"],
  ["hetzner", "Hetzner"],
  ["your-server.de", "Hetzner"],
  ["digitalocean", "DigitalOcean"],
  ["amazon ec2", "AWS"],
  ["amazonaws", "AWS"],
  ["google compute engine", "Google Cloud"],
  ["googleusercontent", "Google Cloud"],
  ["linode", "Linode"],
  ["akamai", "Linode"],
  ["vultr", "Vultr"],
  ["scaleway", "Scaleway"],
  ["ovh", "OVHcloud"],
  ["oraclecloud", "Oracle Cloud"],
  ["azure", "Azure"],
];

export function hostingProviderFromText(text: string | null | undefined): string | null {
  const lower = text?.toLowerCase() ?? "";
  if (lower.length === 0) return null;
  return HOSTING_PROVIDERS.find(([marker]) => lower.includes(marker))?.[1] ?? null;
}

/** The icon shape for an environment icon, detected or picked in Settings. */
export function hardwareFromMachineKind(kind: EnvironmentMachineKind): MachineHardware {
  switch (kind) {
    case "laptop":
      return "laptop";
    case "desktop":
    case "mac-mini":
    case "mac-studio":
      return "desktop";
    case "server":
    case "cloud":
    case "linux":
      return "server";
  }
}

/**
 * Pure decision from the collected signals. A VM or a Linux box without a
 * graphical session is a cloud server; anything else is a personal computer.
 */
export function classifyMachine(input: {
  readonly platform: ExecutionEnvironmentPlatformOs;
  readonly detectedKind: EnvironmentMachineKind | null;
  readonly hasBattery: boolean;
  readonly hasGraphicalSession: boolean;
  readonly hostingProvider: string | null;
}): MachineFacts {
  const cloud =
    input.platform === "linux" &&
    (input.detectedKind === "cloud" ||
      input.detectedKind === "server" ||
      input.hostingProvider !== null ||
      (!input.hasGraphicalSession && !input.hasBattery));
  if (cloud) {
    return { role: "cloud-server", hardware: "server", hostingProvider: input.hostingProvider };
  }
  const hardware =
    input.detectedKind === null || input.detectedKind === "linux" || input.detectedKind === "cloud"
      ? input.hasBattery
        ? "laptop"
        : "desktop"
      : hardwareFromMachineKind(input.detectedKind);
  return { role: "computer", hardware, hostingProvider: null };
}

/** "Alex's MacBook Pro" for a computer; "Cloud server · Contabo" for a server. */
export function defaultMachineName(input: {
  readonly role: MachineRole;
  readonly environmentLabel: string;
  readonly hostname: string | null;
  readonly hostingProvider: string | null;
}): string {
  if (input.role === "computer") return input.environmentLabel;
  const detail = input.hostingProvider ?? input.hostname ?? input.environmentLabel;
  return `Cloud server · ${detail}`;
}

const readOptional = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );

const probe = (command: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) =>
      runner.run({ command, args, timeout: "5 seconds", timeoutBehavior: "timedOutResult" }),
    ),
    Effect.map((result) => (result.code === 0 ? result.stdout : "")),
    Effect.orElseSucceed(() => ""),
  );

const hasLinuxBattery = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const supplies = yield* fileSystem
    .readDirectory("/sys/class/power_supply")
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  return supplies.some((name) => name.startsWith("BAT"));
});

// A public address on an interface is common on VPSes; its PTR record often
// names the host (vmi123.contaboserver.net). Bounded to one lookup.
const reverseDnsProvider = Effect.gen(function* () {
  const address = Object.values(NodeOS.networkInterfaces())
    .flat()
    .find(
      (entry) =>
        entry !== undefined &&
        entry.family === "IPv4" &&
        !entry.internal &&
        !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
          entry.address,
        ),
    )?.address;
  if (address === undefined) return null;
  const names = yield* Effect.tryPromise(() => NodeDnsPromises.reverse(address)).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  const found = names?._tag === "Some" ? names.value : [];
  return found.map(hostingProviderFromText).find((name) => name !== null) ?? null;
});

export const detectMachineFacts = Effect.fn("detectMachineFacts")(function* (input: {
  readonly platform: ExecutionEnvironmentPlatformOs;
  readonly detectedKind: EnvironmentMachineKind | null;
}) {
  const hostname = yield* HostProcess.Hostname;
  if (input.platform === "darwin") {
    const battery = yield* probe("pmset", ["-g", "batt"]);
    return classifyMachine({
      ...input,
      hasBattery: battery.includes("InternalBattery"),
      hasGraphicalSession: true,
      hostingProvider: null,
    });
  }
  if (input.platform !== "linux") {
    return classifyMachine({
      ...input,
      hasBattery: false,
      hasGraphicalSession: true,
      hostingProvider: null,
    });
  }
  const env = yield* HostProcess.Environment;
  const hasGraphicalSession =
    Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY) || Boolean(env.XDG_CURRENT_DESKTOP);
  const [vendor, product, hasBattery] = yield* Effect.all([
    readOptional("/sys/class/dmi/id/sys_vendor"),
    readOptional("/sys/class/dmi/id/product_name"),
    hasLinuxBattery,
  ]);
  const fromHost =
    hostingProviderFromText(`${vendor} ${product}`) ?? hostingProviderFromText(hostname);
  const looksLikeServer =
    input.detectedKind === "cloud" || (!hasGraphicalSession && !hasBattery) || fromHost !== null;
  const hostingProvider = fromHost ?? (looksLikeServer ? yield* reverseDnsProvider : null);
  return classifyMachine({ ...input, hasBattery, hasGraphicalSession, hostingProvider });
});

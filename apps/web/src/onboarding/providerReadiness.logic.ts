import {
  type ExecutionEnvironmentPlatformOs,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@cogenly/contracts";

import { providerClients } from "../components/settings/providerDriverMeta";

const SAFE_SHELL_BINARY_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_BINARY_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

const PROVIDER_STATE_PRIORITY = {
  checking: 0,
  disabled: 1,
  install: 2,
  attention: 3,
  signIn: 4,
  ready: 5,
} as const;

/** Select the most usable configured instance for each provider driver. */
export function selectOnboardingProvidersByDriver(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
) {
  const providersByDriver = new Map<string, ServerProvider>();

  for (const provider of providers ?? []) {
    const existing = providersByDriver.get(provider.driver);
    if (
      existing === undefined ||
      PROVIDER_STATE_PRIORITY[getOnboardingProviderState(provider)] >
        PROVIDER_STATE_PRIORITY[getOnboardingProviderState(existing)]
    ) {
      providersByDriver.set(provider.driver, provider);
    }
  }

  return providersByDriver;
}

/**
 * Install command for the setup terminal, from the driver's registry entry:
 * official standalone installers that need neither Node nor npm and land in
 * the paths provider maintenance recognizes as native, so the one-click
 * updater in Settings keeps working after install. Keyed on the
 * environment's platform (not the client's): a Windows desktop driving a
 * WSL server gets the shell script. Unknown platforms get the shell script
 * too, since the terminal there is a POSIX shell in practice. Drivers
 * without installers fall back to their slug, like the login command.
 */
export function resolveOnboardingProviderInstallCommand(
  driver: ProviderDriverKind,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const commands = providerClients.get(driver)?.onboarding?.installCommands;
  if (commands === undefined) return driver;
  return platform === "windows" ? commands.windows : commands.posix;
}

/** Use the selected provider instance's binary when the setup terminal opens its login flow. */
export function resolveOnboardingProviderLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const onboarding = providerClients.get(provider.driver)?.onboarding;
  const loginSubcommand = onboarding?.loginSubcommand;
  const binaryFallback = onboarding?.binaryFallback ?? provider.driver;
  if (loginSubcommand === undefined) return provider.driver;

  // Read `binaryPath` the way its setting decodes: trimmed, empty means the
  // default. Matches `makeBinaryPathSetting` for every input shape.
  const rawBinary = (
    settings.providerInstances[provider.instanceId]?.config as
      | { readonly binaryPath?: unknown }
      | undefined
  )?.binaryPath;
  const trimmed = typeof rawBinary === "string" ? rawBinary.trim() : "";
  const binaryPath = trimmed.length > 0 ? trimmed : binaryFallback;
  return `${quoteProviderBinary(binaryPath, binaryFallback, platform)} ${loginSubcommand}`;
}

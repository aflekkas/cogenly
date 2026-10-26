/**
 * What this server says about itself as a machine: name, role, icon shape,
 * platform and provider sign-ins. Detection runs once at startup; the
 * `machineName` and `machineRole` settings override it, and the existing
 * `environmentIcon` setting overrides the hardware shape.
 */
import {
  MachineError,
  type MachineProvider,
  type MachineSelfReport,
  type MachineUpdateInput,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  defaultMachineName,
  detectMachineFacts,
  hardwareFromMachineKind,
} from "./machineDetection.ts";

export class MachineIdentity extends Context.Service<
  MachineIdentity,
  {
    readonly self: Effect.Effect<MachineSelfReport>;
    readonly update: (input: MachineUpdateInput) => Effect.Effect<void, MachineError>;
    /** Emits when the machine's settings or provider status changes. */
    readonly changes: Stream.Stream<void>;
  }
>()("cogenly-server/machines/MachineIdentity") {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const descriptor = yield* environment.getDescriptor;
  const hostname = yield* HostProcess.Hostname;
  // Probes can take seconds (pmset, reverse DNS); run them on first use, not at startup.
  const probeContext = yield* Effect.context<FileSystem.FileSystem | ProcessRunner.ProcessRunner>();
  const detectFacts = yield* Effect.cached(
    detectMachineFacts({
      platform: descriptor.platform.os,
      detectedKind: descriptor.platform.machine ?? null,
    }).pipe(Effect.provideContext(probeContext)),
  );

  const providerStatus = providers.getProviders.pipe(
    Effect.map((snapshots) =>
      snapshots.map((provider): MachineProvider => ({
        instanceId: provider.instanceId,
        displayName: provider.displayName ?? provider.instanceId,
        enabled: provider.enabled,
        auth: provider.auth.status,
        installed: provider.installed,
        canAuthenticate: provider.setup?.canAuthenticate ?? false,
      })),
    ),
  );

  const self: MachineIdentity["Service"]["self"] = Effect.gen(function* () {
    const facts = yield* detectFacts;
    const current = yield* settings.getSettings.pipe(Effect.option);
    const configured = current._tag === "Some" ? current.value : undefined;
    const role = configured?.machineRole ?? facts.role;
    const icon = configured?.environmentIcon ?? null;
    return {
      environmentId: descriptor.environmentId,
      name:
        configured?.machineName ??
        defaultMachineName({
          role,
          environmentLabel: descriptor.label,
          hostname: hostname.trim().length > 0 ? hostname : null,
          hostingProvider: facts.hostingProvider,
        }),
      role,
      hardware:
        icon !== null
          ? hardwareFromMachineKind(icon)
          : role === "cloud-server"
            ? "server"
            : facts.hardware,
      platform: descriptor.platform.os,
      serverVersion: descriptor.serverVersion,
      providers: yield* providerStatus,
    } satisfies MachineSelfReport;
  }).pipe(Effect.withSpan("MachineIdentity.self"));

  const update: MachineIdentity["Service"]["update"] = (input) =>
    settings
      .updateSettings({
        ...(input.name === undefined ? {} : { machineName: input.name }),
        ...(input.role === undefined ? {} : { machineRole: input.role }),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new MachineError({ operation: "update", reason: "storage", cause }),
        ),
        Effect.withSpan("MachineIdentity.update"),
      );

  const changes = Stream.merge(
    settings.streamChanges.pipe(
      Stream.map((next) => [next.machineName, next.machineRole, next.environmentIcon] as const),
      Stream.changesWith((a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]),
    ),
    providers.streamChanges,
  ).pipe(Stream.as(undefined));

  return MachineIdentity.of({ self, update, changes });
});

export const layer = Layer.effect(MachineIdentity, make);

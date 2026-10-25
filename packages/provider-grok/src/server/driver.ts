import { ProviderDriverKind } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@cogenly/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@cogenly/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@cogenly/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@cogenly/provider-core/server/ProviderLatestVersions";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@cogenly/provider-core/server/driver";
import { ProviderDriverError } from "@cogenly/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@cogenly/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@cogenly/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@cogenly/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@cogenly/provider-core/server/managedProvider";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@cogenly/provider-core/server/snapshotSettings";

import { GrokSettings } from "../settings.ts";
import { createGrokAcpHost, makeGrokEnvironment } from "./acp.ts";
import { makeGrokAdapterV2 } from "./adapter.ts";
import { enrichGrokSnapshot, grokMaintenance } from "./maintenance.ts";
import { GROK_DEFAULT_MODEL } from "./modelCatalog.ts";
import { checkGrokProviderStatus, makePendingGrokProvider } from "./status.ts";
import { makeGrokTextGeneration } from "./textGeneration.ts";
import { resolveGrokUsageLimitsCachePath, writeCachedGrokUsageLimits } from "./usageLimitsCache.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

export type GrokDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
    // Off until the user adds it; contracts lists grok as default-disabled.
    hasDefaultInstance: false,
    defaultModel: GROK_DEFAULT_MODEL,
    defaultTextGenerationModel: GROK_DEFAULT_MODEL,
    pickerVisible: true,
  },
  configSchema: GrokSettings,
  defaultConfig: () => decodeGrokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const { cwd } = host.paths;
      const hostEnvironment = yield* HostProcess.Environment;
      // Drop inherited xAI API keys so Grok uses its login; an instance value still wins.
      const processEnvironment = yield* mergeProviderInstanceEnvironment(
        environment,
        makeGrokEnvironment(hostEnvironment),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      } satisfies GrokSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const usageLimitsCachePath = yield* resolveGrokUsageLimitsCachePath({
        cacheDir: host.paths.providerStatusCacheDir,
        instanceId,
      }).pipe(Effect.provideService(Path.Path, path));
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(grokMaintenance, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingGrokProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkGrokProviderStatus(
          effectiveConfig,
          processEnvironment,
          cwd,
          createGrokAcpHost,
          usageLimitsCachePath,
        ).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichGrokSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Grok snapshot.",
              cause,
            }),
        ),
      );
      const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
      const orchestrationAdapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
        modelCatalog,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onUsageLimits: (limits) =>
          snapshot
            .applyUsageLimits(limits)
            .pipe(
              Effect.andThen(
                writeCachedGrokUsageLimits(usageLimitsCachePath, limits).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.tapError(Effect.logError),
                  Effect.ignore,
                ),
              ),
            ),
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, {
        environment: processEnvironment,
        modelCatalog,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

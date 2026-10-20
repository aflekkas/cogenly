import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost, MuseSdkHostOptions } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";
import { parseMuseUsageLimits } from "./usageLimits.ts";
import { writeCachedMuseUsageLimits } from "./usageLimitsCache.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: {
      grantedCapabilities: [],
      serverInfo: { name: "muse", version: "1.4.11" },
    },
    connection: {
      request: vi.fn(async (method: string) => (method === "usage/read" ? {} : catalog)),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-discovered",
      displayLabel: "Muse Discovered",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not start a host when disabled", () =>
    Effect.gen(function* () {
      const createHost = vi.fn(async () => makeHost(metaCatalog));
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: false }),
        {},
        undefined,
        createHost,
      );
      expect(snapshot.status).toBe("disabled");
      expect(createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("gives host-local install and login guidance for a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/muse" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("muse login");
      expect(snapshot.message).toContain("this Cogenly server host");
    }),
  );

  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-discovered",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledTimes(snapshot.status === "error" ? 1 : 2);
      }),
    ),
  );

  it.effect("reads real subscription windows and exposes full access only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const observation = {
          observedAtMs: 1_792_166_400_000,
          tier: "pro",
          window: { usedPercent: 12, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
          weekly: { usedPercent: 34, resetsAtMs: 1_792_771_200_000 },
        };
        vi.mocked(host.connection.request).mockImplementation(async (method) =>
          method === "usage/read" ? { usage: observation } : metaCatalog,
        );
        const seen: Array<MuseSdkHostOptions> = [];
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async (options) => {
            seen.push(options);
            return host;
          },
        );
        expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
        expect(snapshot.usageLimits?.windows.map((window) => window.usedPercent)).toEqual([12, 34]);
        expect(snapshot.usageLimits?.unavailable).toBeUndefined();
        expect(host.connection.request).toHaveBeenCalledWith("usage/read", {});
        expect(host.close).toHaveBeenCalledTimes(2);
        // The usage probe never attaches an MCP server, so it skips the capability.
        expect(seen.some((options) => options.sessionMcp === false)).toBe(true);
      }),
    ),
  );

  it.effect("serves cached limits when the fresh host has no observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const cached = parseMuseUsageLimits({
          observedAtMs: 1_792_166_400_000,
          tier: "pro",
          window: { usedPercent: 12, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
          weekly: { usedPercent: 34, resetsAtMs: 1_792_771_200_000 },
        })!;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-cache-" });
        const cachePath = `${directory}/muse.json`;
        yield* writeCachedMuseUsageLimits(cachePath, cached);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
          cachePath,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.usageLimits).toEqual(cached);
        expect(snapshot.usageLimits?.checkedAt).toBe(cached.checkedAt);
      }),
    ),
  );

  it.effect("prefers a live observation over stale cached limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const live = {
          observedAtMs: 1_792_200_000_000,
          tier: "pro",
          window: { usedPercent: 56, resetsAtMs: 1_792_218_000_000, windowDurationMins: 300 },
          weekly: { usedPercent: 78, resetsAtMs: 1_792_771_200_000 },
        };
        vi.mocked(host.connection.request).mockImplementation(async (method) =>
          method === "usage/read" ? { usage: live } : metaCatalog,
        );
        const stale = parseMuseUsageLimits({
          observedAtMs: 1_792_166_400_000,
          tier: "pro",
          window: { usedPercent: 12, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
          weekly: { usedPercent: 34, resetsAtMs: 1_792_771_200_000 },
        })!;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-cache-" });
        const cachePath = `${directory}/muse.json`;
        yield* writeCachedMuseUsageLimits(cachePath, stale);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
          cachePath,
        );
        expect(snapshot.usageLimits?.windows.map((window) => window.usedPercent)).toEqual([56, 78]);
        expect(snapshot.usageLimits?.checkedAt).not.toBe(stale.checkedAt);
      }),
    ),
  );

  it.effect("keeps the banner honest only when nothing was ever observed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.usageLimits?.windows).toEqual([]);
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("probeFailed");
        expect(snapshot.usageLimits?.unavailable?.message).toBe(
          "Muse hasn't reported limits yet. They'll show up after your next Muse Code message.",
        );
      }),
    ),
  );

  it.effect("closes the host after malformed metadata and reports unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [{ modelId: 1 }] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledTimes(snapshot.status === "error" ? 1 : 2);
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledTimes(snapshot.status === "error" ? 1 : 2);
      }),
    ),
  );
});

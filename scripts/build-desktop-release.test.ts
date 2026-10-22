import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { createBuildConfig, MAC_AUDIO_INPUT_ENTITLEMENT } from "./build-desktop-artifact.ts";

const configFor = (version: string, signed = false, mock = false) =>
  createBuildConfig("mac", "dmg", version, signed, mock, 3000, undefined).pipe(
    Effect.provide(NodeServices.layer),
  );

describe("desktop release packaging", () => {
  it.effect("publishes prod and staging feeds only to Cogenly with DMG and updater zip", () =>
    Effect.gen(function* () {
      for (const [version, channel] of [
        ["1.2.3", "latest"],
        ["1.2.3-staging.20261019.42", "staging"],
      ] as const) {
        const config = yield* configFor(version);
        expect(config.publish).toEqual([
          {
            provider: "github",
            owner: "aflekkas",
            repo: "cogenly",
            channel,
            releaseType: channel === "staging" ? "prerelease" : "release",
          },
        ]);
        expect(config.generateUpdatesFilesForAllChannels).toBe(false);
        expect(config.mac).toMatchObject({ target: ["dmg", "zip"], identity: null });
      }
    }),
  );
  it.effect("signs and notarizes without requiring a passkey provisioning profile", () =>
    Effect.gen(function* () {
      const config = yield* configFor("1.2.3", true);
      expect(config.mac).toMatchObject({ notarize: true, hardenedRuntime: true });
      expect(config.mac).not.toHaveProperty("provisioningProfile");
      // Dictation needs microphone capture under the hardened runtime.
      const entitlements = (config.mac as { entitlements: string }).entitlements;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(entitlements)).toContain(MAC_AUDIO_INPUT_ENTITLEMENT);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("ships the dictation helper and a microphone usage description on macOS", () =>
    Effect.gen(function* () {
      const config = yield* configFor("1.2.3");
      expect(config.extraResources).toContainEqual({
        from: "apps/desktop/prod-resources/speech-helper",
        to: "speech-helper",
      });
      expect(config.mac).toMatchObject({
        extendInfo: { NSMicrophoneUsageDescription: expect.any(String) },
      });
    }),
  );
  it.effect("keeps local update testing on localhost and retired previews without a feed", () =>
    Effect.gen(function* () {
      expect((yield* configFor("1.2.3", false, true)).publish).toEqual([
        { provider: "generic", url: "http://localhost:3000", channel: "latest" },
      ]);
      expect((yield* configFor("1.2.3-preview.20261019.42")).publish).toBeUndefined();
    }),
  );
});

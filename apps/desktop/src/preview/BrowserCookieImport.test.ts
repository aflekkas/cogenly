import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BrowserSession from "./BrowserSession.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as SitePermissions from "./SitePermissions.ts";
import { SitePermissionsController } from "./SitePermissionsController.ts";
import { SitePermissionStore } from "./SitePermissionStore.ts";

const { fromPartition, set, flushStore, clearStorageData } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  set: vi.fn(),
  flushStore: vi.fn(),
  clearStorageData: vi.fn(),
}));
vi.mock("electron", () => ({
  session: { fromPartition },
  BrowserWindow: {},
  systemPreferences: {},
}));

const cookie = {
  url: "https://github.com/auth",
  name: "session",
  value: "synthetic-local-pipe-secret",
  domain: undefined,
  path: "/auth",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "strict" as const,
};
const program = <E>(
  use: (session: BrowserSession.BrowserSession["Service"]) => Effect.Effect<void, E>,
) =>
  Effect.flatMap(BrowserSession.BrowserSession, use).pipe(
    Effect.provide(
      BrowserSession.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ElectronDialog.ElectronDialog)({}),
            Layer.succeed(SitePermissions.SitePermissions, {
              controller: new SitePermissionsController(
                new SitePermissionStore(null, { isPersistent: () => true, onChange: () => {} }),
                () => "fixture",
              ),
            }),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

it.effect(
  "imports into the exact native profile while keeping host-only scope, flags and session expiry",
  () =>
    Effect.gen(function* () {
      fromPartition.mockReset().mockImplementation(() => ({
        cookies: { set, flushStore },
        clearStorageData,
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      }));
      set.mockReset().mockResolvedValue(undefined);
      flushStore.mockReset().mockResolvedValue(undefined);
      yield* program((session) =>
        Effect.gen(function* () {
          expect(yield* session.importCookie("environment", "work", cookie)).toBe(true);
          expect(fromPartition.mock.calls[0]?.[0]).toBe(
            yield* session.getPartition('["environment","work"]', true, "profile"),
          );
          expect(set.mock.calls[0]?.[0]).toEqual({
            url: cookie.url,
            name: cookie.name,
            value: cookie.value,
            path: "/auth",
            secure: true,
            httpOnly: true,
            sameSite: "strict",
          });
          expect(flushStore).toHaveBeenCalledOnce();
          expect(
            yield* session.importCookie("environment", "default", {
              ...cookie,
              domain: ".github.com",
              expirationDate: 4102444800,
            }),
          ).toBe(true);
          expect(fromPartition.mock.calls[1]?.[0]).toBe(
            yield* session.getPartition("environment", true),
          );
          expect(set.mock.calls[1]?.[0]).toMatchObject({
            domain: ".github.com",
            expirationDate: 4102444800,
          });
        }),
      );
    }),
);

it.effect("returns only failure metadata when the native writer rejects a cookie", () =>
  Effect.gen(function* () {
    fromPartition.mockReset().mockImplementation(() => ({
      cookies: { set, flushStore },
      clearStorageData,
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    }));
    set.mockReset().mockRejectedValue(new Error(cookie.value));
    yield* program((session) =>
      Effect.gen(function* () {
        expect(yield* session.importCookie("environment", "default", cookie)).toBe(false);
      }),
    );
  }),
);

it.effect("clears the selected native profile without clearing another profile", () =>
  Effect.gen(function* () {
    fromPartition.mockReset().mockImplementation(() => ({
      cookies: { set, flushStore },
      clearStorageData,
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    }));
    clearStorageData.mockReset().mockResolvedValue(undefined);
    yield* program((session) =>
      Effect.gen(function* () {
        expect(yield* session.clearProfileData("local", "work")).toBe(true);
        expect(fromPartition).toHaveBeenCalledOnce();
        expect(fromPartition.mock.calls[0]?.[0]).toBe(
          yield* session.getPartition('["local","work"]', true, "profile"),
        );
        expect(clearStorageData).toHaveBeenCalledWith({
          storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
        });
      }),
    );
  }),
);

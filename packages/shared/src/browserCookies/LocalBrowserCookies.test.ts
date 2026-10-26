// @effect-diagnostics nodeBuiltinImport:off - Synthetic SQLite, cipher and binary fixtures exercise the actual on-disk formats.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as HostProcess from "../HostProcess.ts";
import { decryptChromiumValue, readChromiumCookieDatabase } from "./ChromiumCookies.ts";
import { snapshotCookieDatabase, type ImportedCookie } from "./CookieDatabase.ts";
import { readFirefoxCookies } from "./FirefoxCookies.ts";
import * as LocalBrowserCookies from "./LocalBrowserCookies.ts";
import { parseBinaryCookies } from "./SafariCookies.ts";

const secret = "SYNTHETIC_COOKIE_VALUE_DO_NOT_LOG";
const temp = Effect.gen(function* () {
  yield* TestClock.setTime(2_000_000_000_000);
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-cookie-test-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  return directory;
});
const createFirefox = (file: string) => {
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(`pragma user_version = 16;
    create table moz_cookies (host text, name text, value text, path text, expiry integer,
      isSecure integer, isHttpOnly integer, sameSite integer, originAttributes text);`);
  const insert = db.prepare("insert into moz_cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(".github.com", "session", secret, "/auth", 4102444800000, 1, 1, 2, "");
  insert.run("api.github.com", "host-only", secret, "/", 0, 1, 0, 256, "");
  insert.run("linear.app", "linear", secret, "/", 4102444800000, 1, 1, 0, "");
  insert.run("github.com", "expired", secret, "/", 1, 1, 1, 1, "");
  insert.run("evilgithub.com", "unrelated", secret, "/", 4102444800000, 1, 1, 1, "");
  insert.run("github.com", "container", secret, "/", 4102444800000, 1, 1, 1, "^userContextId=2");
  db.close();
};

const withReader = <A, E>(
  home: string,
  use: (reader: LocalBrowserCookies.LocalBrowserCookies["Service"]) => Effect.Effect<A, E>,
  platform: NodeJS.Platform = "linux",
) =>
  Effect.flatMap(LocalBrowserCookies.LocalBrowserCookies, use).pipe(
    Effect.provide(LocalBrowserCookies.layer),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

const firefoxHome = Effect.gen(function* () {
  const home = yield* temp;
  const profile = NodePath.join(home, ".mozilla", "firefox", "test.default");
  yield* Effect.promise(() => NodeFSP.mkdir(profile, { recursive: true }));
  createFirefox(NodePath.join(profile, "cookies.sqlite"));
  return { home, profile };
});

it.layer(NodeServices.layer)("local browser cookies", (it) => {
  it.effect(
    "decrypts a snapshotted Chromium DB with a test macOS key, host binding and flags",
    () =>
      Effect.gen(function* () {
        const directory = yield* temp;
        const file = NodePath.join(directory, "Cookies");
        const key = NodeCrypto.pbkdf2Sync("test-safe-storage-key", "saltysalt", 1003, 16, "sha1");
        const encrypt = (host: string) => {
          const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
          return Buffer.concat([
            Buffer.from("v10"),
            cipher.update(
              Buffer.concat([
                NodeCrypto.createHash("sha256").update(host).digest(),
                Buffer.from(secret),
              ]),
            ),
            cipher.final(),
          ]);
        };
        const encrypted = encrypt(".github.com");
        expect(decryptChromiumValue(encrypted, { cbcV10: key }, ".github.com", 24, "darwin")).toBe(
          secret,
        );
        expect(
          decryptChromiumValue(encrypted, { cbcV10: key }, "other.com", 24, "darwin"),
        ).toBeNull();
        expect(
          decryptChromiumValue(
            encrypted,
            { cbcV10: Buffer.alloc(16) },
            ".github.com",
            24,
            "darwin",
          ),
        ).toBeNull();
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec(`pragma journal_mode = WAL;
        create table meta (key text, value text); insert into meta values ('version', '24');
        create table cookies (host_key text, name text, value text, encrypted_value blob,
          path text, expires_utc integer, is_secure integer, is_httponly integer,
          samesite integer, top_frame_site_key text);`);
          const insert = db.prepare(
            "insert into cookies values (?, 'session', '', ?, '/auth', ?, 1, 1, 2, ?)",
          );
          insert.run(".github.com", encrypted, 15746918400000000n, "");
          insert.run("other.com", encrypted, 0, "");
          insert.run(".github.com", encrypted, 0, "https://partition.example");
          const result = yield* Effect.gen(function* () {
            const snapshot = yield* snapshotCookieDatabase(file);
            return yield* readChromiumCookieDatabase(snapshot, { cbcV10: key }, "darwin");
          });
          expect(result.cookies).toHaveLength(1);
          expect(result.cookies[0]).toMatchObject({
            value: secret,
            domain: ".github.com",
            path: "/auth",
            secure: true,
            httpOnly: true,
            sameSite: "strict",
            expirationDate: 4102444800,
          });
          expect(result.undecryptable).toBe(2);
          expect(db.prepare("select count(*) as count from cookies").get()?.count).toBe(3);
        } finally {
          db.close();
        }
      }),
  );

  it.effect("parses the synthetic Safari binarycookies fixture and rejects a truncated jar", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        NodeFSP.readFile(new URL("./fixtures/synthetic.binarycookies", import.meta.url)),
      );
      const cookies = parseBinaryCookies(fixture);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({
        value: secret,
        domain: ".github.com",
        path: "/auth",
        secure: true,
        httpOnly: true,
        expirationDate: 4102444800,
        sameSite: "lax",
      });
      expect(() => parseBinaryCookies(fixture.subarray(0, fixture.length - 1))).toThrow(
        "readFailed",
      );
    }),
  );

  it.effect(
    "reads Firefox without a key, preserves host-only scope, expiry units and SameSite",
    () =>
      Effect.gen(function* () {
        const { profile } = yield* firefoxHome;
        const cookies = yield* readFirefoxCookies(NodePath.join(profile, "cookies.sqlite"));
        expect(cookies).toHaveLength(5);
        expect(cookies[0]).toMatchObject({
          domain: ".github.com",
          path: "/auth",
          secure: true,
          httpOnly: true,
          expirationDate: 4102444800,
          sameSite: "strict",
        });
        expect(cookies[1]).toMatchObject({
          domain: undefined,
          expirationDate: undefined,
          sameSite: "unspecified",
        });
        expect(cookies[2]?.sameSite).toBe("no_restriction");
      }),
  );

  it.effect("discovers profiles and previews domain counts without writing or leaking values", () =>
    Effect.gen(function* () {
      const { home } = yield* firefoxHome;
      const writes: ImportedCookie[] = [];
      const logs: unknown[] = [];
      const result = yield* withReader(home, (reader) =>
        Effect.gen(function* () {
          const sources = yield* reader.listSources;
          expect(sources.map((source) => source.id)).toEqual(["firefox"]);
          expect(sources[0]?.profiles[0]?.directory).toBe("test.default");
          return yield* reader.importCookies(
            { sourceId: "firefox", domains: ["GITHUB.COM"], dryRun: true },
            async (_, cookie) => {
              writes.push(cookie);
            },
          );
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      expect(writes).toEqual([]);
      expect(result).toMatchObject({
        dryRun: true,
        imported: 0,
        available: 2,
        skipped: 1,
        reloadRequired: false,
        domains: [
          { domain: "api.github.com", count: 1 },
          { domain: "github.com", count: 1 },
        ],
      });
      expect(JSON.stringify({ result, logs })).not.toContain(secret);
    }),
  );

  it.effect(
    "imports only requested domains and flags, skips expired cookies, and targets one profile",
    () =>
      Effect.gen(function* () {
        const { home } = yield* firefoxHome;
        const written: { profile: string; cookie: ImportedCookie }[] = [];
        const result = yield* withReader(home, (reader) =>
          reader.importCookies(
            {
              sourceId: "firefox",
              sourceProfileDirectory: "test.default",
              targetProfileId: "work",
              domains: ["github.com"],
            },
            async (profile, cookie) => {
              written.push({ profile, cookie });
            },
          ),
        );
        expect(written).toHaveLength(2);
        expect(written.every((entry) => entry.profile === "work")).toBe(true);
        expect(written[0]?.cookie).toMatchObject({
          secure: true,
          httpOnly: true,
          sameSite: "strict",
          path: "/auth",
        });
        expect(result).toMatchObject({
          imported: 2,
          available: 2,
          skipped: 1,
          reloadRequired: true,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      }),
  );

  it.effect(
    "supports all domains, reports target rejections without their secret-bearing errors",
    () =>
      Effect.gen(function* () {
        const { home } = yield* firefoxHome;
        const result = yield* withReader(home, (reader) =>
          reader.importCookies({ sourceId: "firefox" }, async () => {
            throw new Error(secret);
          }),
        );
        expect(result).toMatchObject({ imported: 0, available: 4, skipped: 5, domains: [] });
        expect(JSON.stringify(result)).not.toContain(secret);
      }),
  );

  it.effect("reports empty hosts and unknown profiles; rejects incognito without a write", () =>
    Effect.gen(function* () {
      const home = yield* temp;
      const empty = yield* withReader(home, (reader) => reader.listSources);
      expect(empty).toEqual([]);
      const { home: populated } = yield* firefoxHome;
      for (const input of [
        { sourceId: "firefox" as const, sourceProfileDirectory: "../outside" },
        { targetProfileId: "incognito" },
      ]) {
        const exit = yield* Effect.exit(
          withReader(populated, (reader) =>
            reader.importCookies(input, async () => {
              throw new Error("should not write");
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("sanitizes malformed database rows before errors reach logs, traces or results", () =>
    Effect.gen(function* () {
      const { home, profile } = yield* firefoxHome;
      const db = new NodeSqlite.DatabaseSync(NodePath.join(profile, "cookies.sqlite"));
      db.exec(`update moz_cookies set isSecure = '${secret}'`);
      db.close();
      const spans: Tracer.NativeSpan[] = [];
      const logs: unknown[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const exit = yield* Effect.exit(
        withReader(home, (reader) =>
          reader.importCookies({ sourceId: "firefox", dryRun: true }, async () => {}),
        ).pipe(
          Effect.withSpan("import-transport"),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provide(
            Logger.layer([
              Logger.make((entry) => {
                logs.push(entry.message);
              }),
            ]),
          ),
        ),
      );
      for (const span of spans) {
        expect(JSON.stringify([...span.attributes])).not.toContain(secret);
        if (span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
          expect(Cause.pretty(span.status.exit.cause)).not.toContain(secret);
      }
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret);
    }),
  );

  it.effect("finds all synthetic macOS Chrome, Dia and Arc profiles and Linux Snap Chromium", () =>
    Effect.gen(function* () {
      const home = yield* temp;
      for (const root of ["Google/Chrome", "Dia/User Data", "Arc/User Data"]) {
        for (const profile of ["Default", "Profile 1"]) {
          const directory = NodePath.join(
            home,
            "Library",
            "Application Support",
            root,
            profile,
            "Network",
          );
          yield* Effect.promise(() => NodeFSP.mkdir(directory, { recursive: true }));
          const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "Cookies"));
          db.exec("create table cookies (name text)");
          db.close();
        }
      }
      const sources = yield* withReader(home, (reader) => reader.listSources, "darwin");
      for (const id of ["chrome", "dia", "arc"])
        expect(
          sources.find((source) => source.id === id)?.profiles.map((profile) => profile.directory),
        ).toEqual(["Default", "Profile 1"]);
      const snap = NodePath.join(home, "snap", "chromium", "common", "chromium", "Default");
      yield* Effect.promise(() => NodeFSP.mkdir(snap, { recursive: true }));
      const db = new NodeSqlite.DatabaseSync(NodePath.join(snap, "Cookies"));
      db.exec("create table cookies (name text)");
      db.close();
      const linux = yield* withReader(home, (reader) => reader.listSources);
      expect(linux.find((source) => source.id === "chromium")?.profiles[0]?.directory).toBe(snap);
    }),
  );

  it.effect("matches domains at label boundaries", () =>
    Effect.sync(() => {
      expect(LocalBrowserCookies.matchesCookieDomain("api.github.com", ["github.com"])).toBe(true);
      expect(LocalBrowserCookies.matchesCookieDomain("evilgithub.com", ["github.com"])).toBe(false);
      expect(
        LocalBrowserCookies.matchesCookieDomain("github.com.attacker.test", ["github.com"]),
      ).toBe(false);
    }),
  );
});

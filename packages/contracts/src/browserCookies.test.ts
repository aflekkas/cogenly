import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DesktopBrowserCommand } from "./desktopBrowser.ts";
import { BrowserCookieImportInput } from "./browserCookies.ts";

const codec = Schema.fromJsonString(DesktopBrowserCommand);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const decodeInput = Schema.decodeUnknownOption(BrowserCookieImportInput);

it("round-trips a host-only session cookie over the local bootstrap pipe", () => {
  const command = {
    type: "importCookie" as const,
    requestId: "fixture",
    environmentId: "local",
    profileId: "work",
    cookie: {
      url: "https://github.com/auth",
      name: "session",
      value: "synthetic-pipe-cookie",
      domain: undefined,
      path: "/auth",
      secure: true,
      httpOnly: true,
      expirationDate: undefined,
      sameSite: "strict" as const,
    },
  };
  expect(decode(encode(command))).toEqual(command);
});

it("rejects URL-shaped and empty domain filters instead of treating them as all domains", () => {
  expect(decodeInput({ domains: [] })._tag).toBe("None");
  expect(decodeInput({ domains: ["https://github.com"] })._tag).toBe("None");
  expect(decodeInput({ domains: ["github.com", "linear.app"] })._tag).toBe("Some");
});

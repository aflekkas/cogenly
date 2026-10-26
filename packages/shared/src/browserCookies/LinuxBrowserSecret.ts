import * as Context from "effect/Context";

/** Optional bundled libsecret reader; headless hosts can use secret-tool instead. */
export const LinuxBrowserSecretPath = Context.Reference<string | undefined>(
  "@cogenly/shared/browserCookies/LinuxBrowserSecretPath",
  { defaultValue: () => undefined },
);

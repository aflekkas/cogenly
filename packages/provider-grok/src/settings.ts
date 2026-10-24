/**
 * Grok Build instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-grok/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GrokSettings = makeProviderSettingsSchema(
  {
    // Off until the user adds Grok; matches DEFAULT_DISABLED_PROVIDER_DRIVERS in contracts.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the Grok Build CLI on this environment. Sign in with grok login on that host.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath"] },
);
export type GrokSettings = typeof GrokSettings.Type;

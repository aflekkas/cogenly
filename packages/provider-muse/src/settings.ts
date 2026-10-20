/**
 * Muse Code instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-muse/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MuseSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("muse").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the Muse Code binary on this environment. Sign in with muse login on that host.",
        providerSettingsForm: { placeholder: "muse", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    limitsAutoRefresh: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Refresh limits automatically",
        description:
          "When Muse hasn't reported limits lately, run one tiny turn on a cheap model to refresh them.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    limitsBumpModel: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Limits refresh model",
        description:
          "Model for automatic limits refreshes. Empty means the cheapest model the account can access.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "", label: "Cheapest available" },
            { value: "muse-spark-1.2", label: "muse-spark-1.2" },
            { value: "muse-spark-1.3", label: "muse-spark-1.3" },
            { value: "muse-wonder-1.0", label: "muse-wonder-1.0" },
            { value: "muse-wonder-full-1.0", label: "muse-wonder-full-1.0" },
          ],
        },
      }),
    ),
    limitsMinInterval: Schema.Literals(["5", "15", "30", "60", "180", "360", "1440"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("30")),
      Schema.annotateKey({
        title: "Minimum limits refresh interval",
        description: "Automatic refreshes run at most this often.",
        providerSettingsForm: {
          control: "select",
          // The first entry is the default the form shows for an unset key.
          options: [
            { value: "30", label: "30 minutes" },
            { value: "5", label: "5 minutes" },
            { value: "15", label: "15 minutes" },
            { value: "60", label: "1 hour" },
            { value: "180", label: "3 hours" },
            { value: "360", label: "6 hours" },
            { value: "1440", label: "24 hours" },
          ],
        },
      }),
    ),
  },
  { order: ["binaryPath", "limitsAutoRefresh", "limitsBumpModel", "limitsMinInterval"] },
);
export type MuseSettings = typeof MuseSettings.Type;

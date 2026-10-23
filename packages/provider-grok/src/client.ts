/**
 * Grok Build's client definition: settings form, label, badge, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-grok/client
 */
import { ProviderDriverKind, UsageProviderKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { GrokSettings } from "./settings.ts";

export const grokClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("grok"),
  label: "Grok",
  settingsSchema: GrokSettings,
  badgeLabel: "Beta",
  defaultModel: "grok-4.7",
  defaultTextGenerationModel: "grok-4.7",
  pickerVisible: true,
  // Grok runs only once the user adds it in Settings → Providers.
  hasDefaultInstance: false,
  usage: {
    providerKind: UsageProviderKind.make("grok"),
    label: "Grok",
    color: "var(--contrast-foreground)",
  },
  // xAI's mark: a slashed, offset "x".
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#000000", dark: "#ffffff" },
    paths: [
      {
        d: "M9.27 15.29l7.98-5.9c.39-.29.95-.18 1.14.27.98 2.37.54 5.22-1.41 7.17-1.95 1.95-4.67 2.38-7.15 1.4l-2.71 1.26c3.89 2.66 8.61 2 11.56-.95 2.34-2.34 3.06-5.53 2.38-8.4l.01.01c-.98-4.23.24-5.92 2.74-9.36L24 .5l-3.29 3.29v-.01L9.27 15.29zM7.63 16.72c-2.78-2.66-2.3-6.77.07-9.14 1.75-1.75 4.62-2.47 7.12-1.42l2.69-1.24c-.48-.35-1.1-.73-1.81-.99-3.2-1.32-7.04-.66-9.64 1.94-2.51 2.51-3.3 6.37-1.94 9.66 1.01 2.46-.65 4.2-2.32 5.96-.59.63-1.19 1.25-1.67 1.92l7.5-6.69z",
      },
    ],
  },
});

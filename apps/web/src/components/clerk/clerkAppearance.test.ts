import { describe, expect, it } from "vite-plus/test";
import { clerkAppearance } from "./clerkAppearance";

describe("clerkAppearance", () => {
  it("maps theme colors without overriding Clerk's component structure", () => {
    expect(clerkAppearance).toEqual({
      variables: {
        colorPrimary: "var(--update-foreground)",
        colorPrimaryForeground: "var(--card)",
        colorDanger: "var(--error)",
        colorSuccess: "var(--success)",
        colorWarning: "var(--warning)",
        colorNeutral: "var(--contrast-foreground)",
        colorForeground: "var(--contrast-foreground)",
        colorMuted: "color-mix(in srgb, var(--card) 98%, var(--contrast-foreground))",
        colorMutedForeground: "var(--contrast-muted-foreground)",
        colorBackground: "var(--card)",
        colorInputForeground: "var(--contrast-foreground)",
        colorInput: "var(--secondary)",
        colorRing: "var(--ring)",
      },
      elements: {
        formFieldErrorText: { color: "var(--error-foreground)" },
        formFieldWarningText: { color: "var(--warning-foreground)" },
        formFieldSuccessText: { color: "var(--success-foreground)" },
        otpCodeFieldErrorText: { color: "var(--error-foreground)" },
        otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
      },
    });
  });
});

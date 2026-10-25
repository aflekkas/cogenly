import { ProviderDriverKind, ProviderInstanceId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextProviderInstanceAccentColor,
  normalizeProviderAccentColor,
  PROVIDER_INSTANCE_AUTO_ACCENT_COLORS,
  providerInstanceRowLabel,
  resolveProviderInstanceAccentColors,
  providerInstanceInitials,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a snapshot name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the snapshot only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});

describe("providerInstanceInitials", () => {
  it("takes the first two characters of a single word", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("takes the first character of each of the first two words", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it("ignores words past the first two", () => {
    expect(providerInstanceInitials("Codex Personal Backup Account")).toBe("CP");
  });

  it("returns an empty string for an empty label", () => {
    expect(providerInstanceInitials("")).toBe("");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  it("accepts a lowercase hex color", () => {
    expect(normalizeProviderAccentColor("#ff8800")).toBe("#ff8800");
  });

  it("accepts an uppercase hex color", () => {
    expect(normalizeProviderAccentColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });

  it("rejects a short hex value", () => {
    expect(normalizeProviderAccentColor("#fff")).toBeUndefined();
  });

  it("treats undefined and blank as unset", () => {
    expect(normalizeProviderAccentColor(undefined)).toBeUndefined();
    expect(normalizeProviderAccentColor("   ")).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined };
    const second = { driverKind: codex, accentColor: undefined };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined };
    const other = { driverKind: claude, accentColor: undefined };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
  });
});

describe("resolveProviderInstanceAccentColors", () => {
  const defaultClaude = { instanceId: "claudeAgent", driver: claude };
  const personalClaude = { instanceId: "claude_personal", driver: claude };

  it("gives instances of one driver distinct colors, default first, regardless of input order", () => {
    const colors = resolveProviderInstanceAccentColors([personalClaude, defaultClaude]);
    expect(colors.get("claudeAgent")).toBe(PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[0]);
    expect(colors.get("claude_personal")).toBe(PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[1]);
  });

  it("leaves a lone instance unmarked", () => {
    const colors = resolveProviderInstanceAccentColors([
      defaultClaude,
      { instanceId: "codex", driver: codex },
    ]);
    expect(colors.size).toBe(0);
  });

  it("lets an explicit accent color win without shifting its siblings", () => {
    const colors = resolveProviderInstanceAccentColors([
      defaultClaude,
      { ...personalClaude, accentColor: "#123456" },
      { instanceId: "claude_work", driver: claude },
    ]);
    expect(colors.get("claudeAgent")).toBe(PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[0]);
    expect(colors.get("claude_personal")).toBe("#123456");
    expect(colors.get("claude_work")).toBe(PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[2]);
  });

  it("preselects the color a new instance would get, skipping one a sibling already shows", () => {
    expect(nextProviderInstanceAccentColor([defaultClaude], claude)).toBe(
      PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[1],
    );
    expect(
      nextProviderInstanceAccentColor(
        [
          defaultClaude,
          { ...personalClaude, accentColor: PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[2] },
        ],
        claude,
      ),
    ).toBe(PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[1]);
  });
});

describe("providerInstanceRowLabel", () => {
  it("names the instance by what sets it apart from the provider", () => {
    expect(
      providerInstanceRowLabel({
        displayName: "Claude (Personal)",
        driverLabel: "Claude",
        sharesDriver: true,
      }),
    ).toBe("Claude · Personal");
    expect(
      providerInstanceRowLabel({
        displayName: "Codex Work",
        driverLabel: "Codex",
        sharesDriver: true,
      }),
    ).toBe("Codex · Work");
    expect(
      providerInstanceRowLabel({
        displayName: "Claude",
        driverLabel: "Claude",
        sharesDriver: true,
      }),
    ).toBe("Claude");
  });

  it("keeps the instance name for a provider with one instance", () => {
    expect(
      providerInstanceRowLabel({
        displayName: "Claude (UChicago)",
        driverLabel: "Claude",
        sharesDriver: false,
      }),
    ).toBe("Claude (UChicago)");
  });
});

import type { AgentAvatar } from "@t3tools/contracts";
import type { CSSProperties } from "react";
import { avatarFace } from "~/components/agents/face/agentAvatar.logic";
import { resolveFaceColor } from "~/components/agents/face/agentFace.logic";

/**
 * The hue an agent's conversation takes from its face: the owner's bubbles, the
 * send button and the composer glow. One source, set as CSS variables on the
 * conversation root (`--agent-accent`, `--agent-accent-foreground`).
 */
export interface AgentAccent {
  /** The fill, a CSS colour. */
  color: string;
  /** White or near-black, whichever reads on the fill in both themes. */
  foreground: string;
}

const DARK_TEXT = "#141416";
const LIGHT_TEXT = "#ffffff";

/** The builder's neutral accent before a face is chosen. */
export const NEUTRAL_ACCENT: AgentAccent = { color: "#7a7d82", foreground: LIGHT_TEXT };

function hexChannels(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG relative luminance of a hex colour; null for anything else. */
export function relativeLuminance(color: string): number | null {
  const channels = hexChannels(color);
  if (!channels) return null;
  const [r, g, b] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: number, b: number): number {
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * White or near-black text, whichever contrasts more with the fill. Colours outside
 * the hex palette (a custom CSS colour) get white, the safe default for the
 * saturated fills the picker offers.
 */
export function accentForeground(color: string): string {
  const luminance = relativeLuminance(color);
  if (luminance === null) return LIGHT_TEXT;
  return contrastRatio(luminance, 1) >= contrastRatio(luminance, relativeLuminance(DARK_TEXT)!)
    ? LIGHT_TEXT
    : DARK_TEXT;
}

/** Face colours whose bubble fill is tuned a step so its text reaches AA (4.5:1). */
const BUBBLE_FILL: Record<string, string> = {
  violet: "#7c4ddc",
};

/** The accent for an agent's face colour: a palette id or any CSS colour. */
export function accentForColor(color: string | undefined): AgentAccent {
  if (!color) return NEUTRAL_ACCENT;
  const resolved = BUBBLE_FILL[color] ?? resolveFaceColor(color);
  return { color: resolved, foreground: accentForeground(resolved) };
}

export function agentAccent(avatar: AgentAvatar): AgentAccent {
  return accentForColor(avatarFace(avatar).color);
}

/** The variables a conversation root sets so bubbles, the send button and glow agree. */
export function accentStyle(accent: AgentAccent): CSSProperties {
  return {
    "--agent-accent": accent.color,
    "--agent-accent-foreground": accent.foreground,
  } as CSSProperties;
}

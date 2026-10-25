import type { ProjectIconColor, ProjectIconOverride } from "@cogenly/contracts";

import type { ProjectPaletteColor } from "./projectIconColors";

/**
 * The glyphs an unconfigured project can get. Folder and repository shapes
 * only, so every fallback still reads as "a project" while two projects in a
 * list rarely look the same. Never letters.
 */
export const PROJECT_FALLBACK_GLYPHS = [
  "folder",
  "folder-git",
  "folder-code",
  "folder-closed",
  "box",
  "boxes",
  "hexagon",
  "layers",
] as const;

export type ProjectFallbackGlyph = (typeof PROJECT_FALLBACK_GLYPHS)[number];

// Muted tints only: the fallback must not out-shout a real favicon next to it.
// Each slot is what its retired hue now shows as (sky, rose, emerald, indigo),
// so every project keeps the tint it had; violet's double weight is that history.
const PROJECT_FALLBACK_COLORS = [
  "gray",
  "blue",
  "teal",
  "violet",
  "amber",
  "red",
  "green",
  "violet",
] as const satisfies ReadonlyArray<ProjectPaletteColor>;

/** Visual identity tokens for a project with no picked icon and no favicon. */
export interface ProjectIdentity {
  readonly glyph: ProjectFallbackGlyph;
  readonly color: ProjectIconColor;
}

function hashProjectName(projectName: string): number {
  const seed = projectName.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let hash = 0;
  for (const glyph of seed) {
    hash = (hash * 31 + (glyph.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

/** Derives the stable glyph and tint used when a project has no icon. */
export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  const hash = hashProjectName(projectName);
  return {
    glyph: PROJECT_FALLBACK_GLYPHS[hash % PROJECT_FALLBACK_GLYPHS.length]!,
    // A second, independent pick so glyph and tint vary separately.
    color:
      PROJECT_FALLBACK_COLORS[
        Math.floor(hash / PROJECT_FALLBACK_GLYPHS.length) % PROJECT_FALLBACK_COLORS.length
      ]!,
  };
}

export type ProjectIconSource =
  | { readonly kind: "picked"; readonly icon: ProjectIconOverride }
  | { readonly kind: "favicon"; readonly src: string }
  | { readonly kind: "fallback"; readonly identity: ProjectIdentity };

/**
 * What a project shows, in order: the icon the user picked in project
 * settings, then the repository's favicon (a file the user chose, or one the
 * server found), then a neutral glyph derived from the name.
 */
export function resolveProjectIconSource(input: {
  readonly projectIcon: ProjectIconOverride | null | undefined;
  /** The resolved favicon URL, or null when the server found none. */
  readonly faviconSrc: string | null;
  readonly projectName: string;
}): ProjectIconSource {
  if (input.projectIcon) return { kind: "picked", icon: input.projectIcon };
  if (input.faviconSrc) return { kind: "favicon", src: input.faviconSrc };
  return { kind: "fallback", identity: deriveProjectIdentity(input.projectName) };
}

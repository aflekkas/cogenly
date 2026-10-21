/**
 * What a removed item left behind for its replacement, or null when there is
 * nothing to hand over. A copy is only ever handed over when its item really
 * left the document. A screen kept alive in a hidden `<Activity>` (a mode's
 * kept-alive thread view) runs the same cleanup as an unmount but stays
 * mounted, and what it showed belongs to that hidden mode: it must never paint
 * over the screen revealed in its place. Nor is anything handed over inside a
 * mode switch's crossfade, which alone brings the new screen in.
 */
export function takeLeavingCopy<T extends { readonly source: { readonly isConnected: boolean } }>(
  entries: Map<string, T>,
  group: string,
  crossfadeRunning: boolean,
): T | null {
  const entry = entries.get(group);
  if (!entry) return null;
  entries.delete(group);
  if (entry.source.isConnected || crossfadeRunning) return null;
  return entry;
}

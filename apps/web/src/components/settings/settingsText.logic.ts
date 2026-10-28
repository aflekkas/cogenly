const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

/**
 * A long folder path short enough for a field's placeholder, which can't
 * scroll to its tail: home as `~`, then the first and last two folders around
 * an ellipsis ("~/…/.cogenly/projects"). Short paths come back as they are.
 */
export function compactPathHint(path: string): string {
  const short = path.replace(HOME_PREFIX, "~");
  const parts = short.split("/");
  if (parts.length <= 4) return short;
  return [parts[0], "…", ...parts.slice(-2)].join("/");
}

/**
 * Long text as its clamped preview shows it: the opening brackets of a
 * pretty-printed JSON payload join the first line with content ("[{"message":
 * …") instead of spending the preview's lines on a bare "[".
 */
export function clampedPreviewText(text: string): string {
  return text.replace(/^[\s[{]*(?=\S)/, (lead) => lead.replace(/\s+/g, ""));
}

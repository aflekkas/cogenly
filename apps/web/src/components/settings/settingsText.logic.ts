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
 * Long text as expandable text shows it, clamped or open: the opening
 * brackets of a pretty-printed JSON payload join the first line with content
 * ("[{"message": …") instead of spending the preview's lines on a bare "[".
 */
export function clampedPreviewText(text: string): string {
  return text.replace(/^[\s[{]*(?=\S)/, (lead) => lead.replace(/\s+/g, ""));
}

/**
 * A CLI's `--version` output as the settings version style ("v2.96.0" for
 * "gh version 2.96.0 (2026-07-02)"). Output with no version number in it
 * comes back as it is.
 */
export function cliVersionLabel(output: string): string {
  const version = /\b\d+\.\d+(?:\.\d+)?\b/.exec(output)?.[0];
  return version === undefined ? output.trim() : `v${version}`;
}

/**
 * A logged `[message, {cause}]` pair as the one line it means
 * ("message: cause"), so a preview leads with the actionable cause. Any other
 * text, including a payload with more fields, comes back as it is so nothing
 * is lost.
 */
export function readableLogMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return text;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return text;
  const [message, detail] = value;
  if (typeof message !== "string") return text;
  if (value.length === 1) return message;
  if (
    typeof detail !== "object" ||
    detail === null ||
    Object.keys(detail).length !== 1 ||
    !("cause" in detail) ||
    typeof detail.cause !== "string"
  ) {
    return text;
  }
  return `${message}: ${detail.cause}`;
}

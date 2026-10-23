/** Replaces vault secret values in text shown to agents. Pure helpers. */

const VAULT_REDACTION = "[redacted vault secret]";
/** Shorter values are too likely to be ordinary words or numbers to scrub safely. */
const MIN_SCRUB_LENGTH = 6;

/** Longest first, so a value that contains another is removed whole. */
const orderedSecrets = (secrets: Iterable<string>): Array<string> =>
  [...new Set([...secrets].filter((value) => value.length >= MIN_SCRUB_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );

export const redactText = (text: string, secrets: Iterable<string>): string => {
  let result = text;
  for (const secret of orderedSecrets(secrets)) result = result.split(secret).join(VAULT_REDACTION);
  return result;
};

/** Deep-copies a tool result, redacting every string inside it. */
export const redactValue = <A>(value: A, secrets: Iterable<string>): A => {
  const ordered = orderedSecrets(secrets);
  if (ordered.length === 0) return value;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      let result = current;
      for (const secret of ordered) result = result.split(secret).join(VAULT_REDACTION);
      return result;
    }
    if (Array.isArray(current)) return current.map(walk);
    if (typeof current === "object" && current !== null)
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, walk(entry)]));
    return current;
  };
  return walk(value) as A;
};

/** Replaces vault secret values in text shown to agents. Pure helpers. */

const VAULT_REDACTION = "[redacted vault secret]";
/** Shorter values are too likely to be ordinary words or numbers to scrub safely. */
const MIN_SCRUB_LENGTH = 6;

/**
 * Values the substring pass cannot take safely: anything under the length
 * floor, and short all-digit values such as one-time codes and PINs, which
 * would otherwise blank part of a longer number. They are matched as whole
 * tokens only.
 */
export const isWholeTokenSecret = (value: string): boolean =>
  value.length < MIN_SCRUB_LENGTH || /^\d{1,8}$/.test(value);

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

/**
 * Deep-copies a tool result, rewriting every string inside it, and object keys
 * too when `keys` is set: a page or upstream can echo a secret as a key.
 */
const mapStrings = <A>(
  value: A,
  rewrite: (text: string) => string,
  { keys }: { readonly keys: boolean },
): A => {
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return rewrite(current);
    if (Array.isArray(current)) return current.map(walk);
    if (typeof current === "object" && current !== null)
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [keys ? rewrite(key) : key, walk(entry)]),
      );
    return current;
  };
  return walk(value) as A;
};

/** Deep-copies a tool result, redacting every string inside it. */
export const redactValue = <A>(value: A, secrets: Iterable<string>): A => {
  const ordered = orderedSecrets(secrets);
  if (ordered.length === 0) return value;
  return mapStrings(
    value,
    (text) => {
      let result = text;
      for (const secret of ordered) result = result.split(secret).join(VAULT_REDACTION);
      return result;
    },
    { keys: true },
  );
};

/** What a tool result says in place of its text when the vault cannot be checked. */
export const VAULT_WITHHELD = "[withheld: the vault could not be checked for secrets]";

/**
 * A tool result with every string replaced by `VAULT_WITHHELD`, for when the
 * secrets to scrub cannot be loaded. Keys stay, so the result keeps its shape
 * and still encodes; every value it said is withheld.
 */
export const withholdValue = <A>(value: A): A =>
  mapStrings(value, () => VAULT_WITHHELD, { keys: false });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Short secrets (a card CVC, an `MM/YY` expiry) fall below `MIN_SCRUB_LENGTH`,
 * so the pass above would leave them. They are only redacted as whole tokens
 * — not inside a longer word or number — so a CVC of `123` does not blank
 * every `1234` in unrelated output, while a page echoing the filled CVC on
 * its own is still caught.
 */
/** One pattern for every short secret, longest first, so the pass runs once per string. */
const wholeTokenPattern = (secrets: Iterable<string>): RegExp | undefined => {
  const list = [...new Set(secrets)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
  return list.length === 0
    ? undefined
    : new RegExp(`(?<![A-Za-z0-9])(?:${list.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "g");
};

export const redactShortSecrets = (text: string, secrets: Iterable<string>): string => {
  const pattern = wholeTokenPattern(secrets);
  return pattern === undefined ? text : text.replace(pattern, VAULT_REDACTION);
};

/** `redactValue` for short secrets: same whole-token rule, applied per string. */
export const redactShortValue = <A>(value: A, secrets: Iterable<string>): A => {
  const pattern = wholeTokenPattern(secrets);
  if (pattern === undefined) return value;
  return mapStrings(value, (text) => text.replace(pattern, VAULT_REDACTION), { keys: true });
};

/** A PTY may split a token across data callbacks. Hold only a possible secret
 * prefix so raw values never enter terminal events, history or disk logs. */
export const processOutputRedactor = (values: Iterable<string>) => {
  const secrets = orderedSecrets(values);
  let pending = "";
  return (chunk: string, final = false): string => {
    const input = pending + chunk;
    pending = "";
    let output = "";
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);
      if (
        !final &&
        secrets.some((secret) => rest.length < secret.length && secret.startsWith(rest))
      ) {
        pending = rest;
        break;
      }
      const match = secrets.find((secret) => input.startsWith(secret, index));
      if (match) {
        output += VAULT_REDACTION;
        index += match.length;
      } else {
        output += input[index];
        index += 1;
      }
    }
    return output;
  };
};

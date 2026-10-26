/** Replaces vault secret values in text shown to agents. Pure helpers. */
import * as DateTime from "effect/DateTime";

const VAULT_REDACTION = "[redacted vault secret]";
/** Shorter values need whole-token matching to avoid masking ordinary substrings. */
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

/** Deep-copies a tool result, rewriting every string inside it. */
const mapStrings = <A>(value: A, rewrite: (text: string) => string): A => {
  const walk = (current: unknown): unknown => {
    // Schema encoders need the DateTime prototype and its symbol brand intact.
    if (DateTime.isDateTime(current)) return current;
    if (typeof current === "string") return rewrite(current);
    if (Array.isArray(current)) return current.map(walk);
    if (typeof current === "object" && current !== null)
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [rewrite(key), walk(entry)]),
      );
    return current;
  };
  return walk(value) as A;
};

/** Deep-copies a tool result, redacting every string inside it. */
export const redactValue = <A>(value: A, secrets: Iterable<string>): A => {
  const ordered = orderedSecrets(secrets);
  if (ordered.length === 0) return value;
  return mapStrings(value, (text) => {
    let result = text;
    for (const secret of ordered) result = result.split(secret).join(VAULT_REDACTION);
    return result;
  });
};

/** What a tool result says in place of its text when the vault cannot be checked. */
export const VAULT_WITHHELD = "[withheld: the vault could not be checked for secrets]";

/**
 * A tool result with every string replaced by `VAULT_WITHHELD`, for when the
 * secrets to scrub cannot be loaded. Keys are withheld too: arbitrary
 * property names can themselves carry secret values.
 */
export const withholdValue = <A>(value: A): A => mapStrings(value, () => VAULT_WITHHELD);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Short secrets (a card CVC, an `MM/YY` expiry) fall below `MIN_SCRUB_LENGTH`,
 * so the pass above would leave them. They are only redacted as whole tokens
 * — not inside a longer word or number — so a CVC of `123` does not blank
 * every `1234` in unrelated output, while a page echoing the filled CVC on
 * its own is still caught.
 */
export const redactShortSecrets = (text: string, secrets: Iterable<string>): string => {
  let result = text;
  for (const secret of [...new Set([...secrets].filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  )) {
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(secret)}(?![\\p{L}\\p{N}_])`, "gu"),
      VAULT_REDACTION,
    );
  }
  return result;
};

/** `redactValue` for short secrets: same whole-token rule, applied per string. */
export const redactShortValue = <A>(value: A, secrets: Iterable<string>): A => {
  const list = [...secrets];
  if (list.length === 0) return value;
  return mapStrings(value, (text) => redactShortSecrets(text, list));
};

/** A PTY may split a token across data callbacks. Hold only a possible secret
 * prefix so raw values never enter terminal events, history or disk logs. */
type SecretSource = Iterable<string> | (() => Iterable<string>);
const readSecrets = (source: SecretSource) => (typeof source === "function" ? source() : source);
const tokenCharacter = /[\p{L}\p{N}_]/u;

export const processOutputRedactor = (values: SecretSource, shortValues: SecretSource = []) => {
  let pending = "";
  let previous = "";
  return (chunk: string, final = false): string => {
    const all = [...readSecrets(values)];
    const short = new Set([
      ...all.filter((value) => value.length < MIN_SCRUB_LENGTH),
      ...readSecrets(shortValues),
    ]);
    const secrets = [...new Set([...all, ...short])]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
    const input = pending + chunk;
    pending = "";
    let output = "";
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);
      const eligible = secrets.filter(
        (secret) => !short.has(secret) || !tokenCharacter.test(previous),
      );
      if (
        !final &&
        eligible.some(
          (secret) =>
            (rest.length < secret.length && secret.startsWith(rest)) ||
            (short.has(secret) && rest === secret),
        )
      ) {
        pending = rest;
        break;
      }
      const match = eligible.find(
        (secret) =>
          input.startsWith(secret, index) &&
          (!short.has(secret) || !tokenCharacter.test(input[index + secret.length] ?? "")),
      );
      if (match) {
        output += VAULT_REDACTION;
        previous = match.at(-1)!;
        index += match.length;
      } else {
        previous = input[index]!;
        output += previous;
        index += 1;
      }
    }
    return output;
  };
};

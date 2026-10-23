/** Replaces vault secret values in text shown to agents. Pure helpers. */

const VAULT_REDACTION = "[redacted vault secret]";
/** Shorter values are too likely to be ordinary words or numbers to scrub inside other text. */
export const MIN_SCRUB_LENGTH = 6;
/** Values from here up to `MIN_SCRUB_LENGTH` are scrubbed as whole tokens only. */
export const MIN_TOKEN_SCRUB_LENGTH = 3;

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
 * Deep-copies a tool result, rewriting every string inside it, and property
 * names too when `rewriteKeys` is set: a record keyed by a secret (headers,
 * a map of tokens) leaks it as surely as a value. Keys that collide after
 * rewriting get a `#n` suffix so no entry is dropped.
 */
const mapStrings = <A>(value: A, rewrite: (text: string) => string, rewriteKeys = false): A => {
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return rewrite(current);
    if (Array.isArray(current)) return current.map(walk);
    if (typeof current === "object" && current !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        let name = rewriteKeys ? rewrite(key) : key;
        if (name !== key)
          for (let n = 2; Object.hasOwn(result, name); n += 1) name = `${rewrite(key)}#${n}`;
        result[name] = walk(entry);
      }
      return result;
    }
    return current;
  };
  return walk(value) as A;
};

/** Deep-copies a tool result, redacting every string and property name inside it. */
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
    true,
  );
};

/** What a tool result says in place of its text when the vault cannot be checked. */
export const VAULT_WITHHELD = "[withheld: the vault could not be checked for secrets]";

/**
 * A tool result with every string replaced by `VAULT_WITHHELD`, for when the
 * secrets to scrub cannot be loaded. The shape stays, so the result still
 * encodes; nothing it said reaches the agent.
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
      new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g"),
      VAULT_REDACTION,
    );
  }
  return result;
};

/** `redactValue` for short secrets: same whole-token rule, applied per string. */
export const redactShortValue = <A>(value: A, secrets: Iterable<string>): A => {
  const list = [...secrets];
  if (list.length === 0) return value;
  return mapStrings(value, (text) => redactShortSecrets(text, list), true);
};

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9]/.test(char);

const byFirstChar = (values: ReadonlyArray<string>): Map<string, Array<string>> => {
  const map = new Map<string, Array<string>>();
  for (const value of values) {
    const list = map.get(value[0]!);
    if (list) list.push(value);
    else map.set(value[0]!, [value]);
  }
  return map;
};

export interface ScrubSets {
  readonly secrets: Iterable<string>;
  readonly shortSecrets: Iterable<string>;
}

/**
 * Redacts output that arrives in chunks, such as a PTY's, where a secret can
 * be split across callbacks. Each `push` redacts against the sets current at
 * that moment: long secrets anywhere, short ones as whole tokens. Only a tail
 * that could still grow into a secret is held back; `final` flushes it.
 */
export const streamRedactor = () => {
  let pending = "";
  // The last character already emitted, for the whole-token rule.
  let previous: string | undefined;
  return {
    hasPending: () => pending.length > 0,
    push: (chunk: string, sets: ScrubSets, final = false): string => {
      const input = pending + chunk;
      const long = orderedSecrets(sets.secrets);
      const short = [...new Set([...sets.shortSecrets].filter((value) => value.length > 0))].sort(
        (a, b) => b.length - a.length,
      );
      const longByFirst = byFirstChar(long);
      const shortByFirst = byFirstChar(short);
      const before = (index: number) => (index === 0 ? previous : input[index - 1]);
      let hold = input.length;
      if (!final) {
        const longest = Math.max(0, ...long.map((s) => s.length), ...short.map((s) => s.length));
        for (let start = Math.max(0, input.length - longest); start < input.length; start += 1) {
          const rest = input.slice(start);
          const first = input[start]!;
          if (
            (longByFirst.get(first) ?? []).some(
              (s) => s.length > rest.length && s.startsWith(rest),
            ) ||
            (!isWordChar(before(start)) &&
              (shortByFirst.get(first) ?? []).some(
                (s) => s.length >= rest.length && s.startsWith(rest),
              ))
          ) {
            hold = start;
            break;
          }
        }
      }
      let output = "";
      let index = 0;
      while (index < hold) {
        const first = input[index]!;
        const match =
          (longByFirst.get(first) ?? []).find((s) => input.startsWith(s, index)) ??
          (isWordChar(before(index))
            ? undefined
            : (shortByFirst.get(first) ?? []).find(
                (s) => input.startsWith(s, index) && !isWordChar(input[index + s.length]),
              ));
        if (match) {
          output += VAULT_REDACTION;
          index += match.length;
        } else {
          output += first;
          index += 1;
        }
      }
      if (index > 0) previous = input[index - 1];
      pending = input.slice(index);
      return output;
    },
  };
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

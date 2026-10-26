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

/** The values a stream redactor matches, and a version that changes when they do. */
export interface StreamSecrets {
  readonly version: number;
  /** Matched anywhere in the output. */
  readonly secrets: ReadonlyArray<string>;
  /** Matched only as whole tokens; see `isWholeTokenSecret`. */
  readonly shortSecrets: ReadonlyArray<string>;
}

interface Automaton {
  readonly next: Array<Map<string, number>>;
  readonly fail: Array<number>;
  readonly depth: Array<number>;
  /** The pattern ending at a node, if any: its length and whether it is whole-token only. */
  readonly pattern: Array<{ readonly length: number; readonly whole: boolean } | undefined>;
  /** The nearest node down the fail chain that ends a pattern, or -1. */
  readonly outLink: Array<number>;
}

/** Aho–Corasick over every secret, so a stream is scanned once whatever the secret count. */
const buildAutomaton = (secrets: StreamSecrets): Automaton => {
  const next: Array<Map<string, number>> = [new Map()];
  const depth = [0];
  const pattern: Automaton["pattern"] = [undefined];
  const add = (value: string, whole: boolean) => {
    if (value.length === 0) return;
    let node = 0;
    // UTF-16 code units, the same steps the scan below takes.
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      let child = next[node]!.get(char);
      if (child === undefined) {
        child = next.length;
        next.push(new Map());
        depth.push(depth[node]! + 1);
        pattern.push(undefined);
        next[node]!.set(char, child);
      }
      node = child;
    }
    // A value matched anywhere also covers its whole-token use.
    const existing = pattern[node];
    pattern[node] = { length: depth[node]!, whole: whole && (existing?.whole ?? true) };
  };
  for (const value of secrets.secrets) add(value, false);
  for (const value of secrets.shortSecrets) add(value, true);
  const fail = Array.from({ length: next.length }, () => 0);
  const outLink = Array.from({ length: next.length }, () => -1);
  const queue = [...next[0]!.values()];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const [char, child] of next[node]!) {
      let candidate = fail[node]!;
      while (candidate !== 0 && !next[candidate]!.has(char)) candidate = fail[candidate]!;
      const target = next[candidate]!.get(char);
      fail[child] = target !== undefined && target !== child ? target : 0;
      outLink[child] = pattern[fail[child]!] !== undefined ? fail[child]! : outLink[fail[child]!]!;
      queue.push(child);
    }
  }
  return { next, fail, depth, pattern, outLink };
};

const isWordChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9]/.test(char);

/**
 * A redactor for output that arrives in chunks, such as a PTY's data
 * callbacks. A secret split across chunks is still caught: only a tail that
 * could begin a secret is held back, until the next chunk or `final`. The
 * secrets are read on every chunk, so values added while it runs are caught
 * from then on.
 */
export const streamRedactor = (current: () => StreamSecrets) => {
  let automaton: { readonly version: number; readonly built: Automaton } | undefined;
  let pending = "";
  // The raw character before `pending`, for the whole-token check at its start.
  let before: string | undefined;
  return (chunk: string, final = false): string => {
    const secrets = current();
    if (automaton?.version !== secrets.version)
      automaton = { version: secrets.version, built: buildAutomaton(secrets) };
    const { next, fail, depth, pattern, outLink } = automaton.built;
    const input = pending + chunk;
    const matches: Array<{ start: number; end: number; whole: boolean }> = [];
    let node = 0;
    for (let index = 0; index < input.length; index++) {
      const char = input[index]!;
      while (node !== 0 && !next[node]!.has(char)) node = fail[node]!;
      node = next[node]!.get(char) ?? 0;
      for (
        let found = pattern[node] ? node : outLink[node]!;
        found !== -1;
        found = outLink[found]!
      ) {
        const { length, whole } = pattern[found]!;
        matches.push({ start: index - length + 1, end: index + 1, whole });
      }
    }
    // Anything that could still grow into a secret waits for more output.
    const hold = final ? input.length : input.length - depth[node]!;
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let output = "";
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor || match.start >= hold) continue;
      if (match.whole) {
        const prior = match.start > 0 ? input[match.start - 1] : before;
        if (isWordChar(prior) || isWordChar(input[match.end])) continue;
      }
      output += input.slice(cursor, match.start) + VAULT_REDACTION;
      cursor = match.end;
    }
    const emitted = Math.max(cursor, hold);
    output += input.slice(cursor, emitted);
    if (emitted > 0) before = input[emitted - 1];
    pending = input.slice(emitted);
    return output;
  };
};

/** Runs output through `first`, then `second`; the final flush passes through both. */
export const composeRedactors =
  (
    first: ((chunk: string, final?: boolean) => string) | undefined,
    second: ((chunk: string, final?: boolean) => string) | undefined,
  ) =>
  (chunk: string, final = false): string => {
    const once = first ? first(chunk, final) : chunk;
    return second ? second(once, final) : once;
  };

/** A PTY may split a token across data callbacks. Hold only a possible secret
 * prefix so raw values never enter terminal events, history or disk logs. */
export const processOutputRedactor = (values: Iterable<string>) => {
  const secrets: StreamSecrets = { version: 0, secrets: orderedSecrets(values), shortSecrets: [] };
  return streamRedactor(() => secrets);
};

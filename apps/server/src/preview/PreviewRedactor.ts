/** Redact credentials created on a page before any preview output reaches an agent. */
export const SECRET_REDACTED = "[secret redacted: use vault_capture]";

const knownCredential =
  /\b(?:GOCSPX-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,}|xox[a-z]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const opaqueToken = /[A-Za-z0-9_+/-]{24,}={0,2}/g;

const redactText = (text: string, passwords: ReadonlyArray<string>) => {
  let result = text;
  for (const password of passwords.filter(Boolean).toSorted((a, b) => b.length - a.length))
    result = result.split(password).join(SECRET_REDACTED);
  return result.replace(knownCredential, SECRET_REDACTED).replace(opaqueToken, (token) => {
    // Browser tab/profile IDs are UUIDs, not credentials.
    if (
      /^(?:tab_[a-z0-9]+_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        token,
      )
    )
      return token;
    // Avoid ordinary words and repeated fixture text. Tokens mix character classes.
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_+/=-]/].filter((pattern) =>
      pattern.test(token),
    ).length;
    const counts = new Map<string, number>();
    for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((sum, count) => {
      const probability = count / token.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    return (classes >= 2 && entropy >= 4) ||
      (classes >= 3 && entropy >= 3.5) ||
      (/^[a-f0-9]{32,}$/i.test(token) && entropy >= 3)
      ? SECRET_REDACTED
      : token;
  });
};

/** Whether text holds something `redactPreview` would redact; screenshot masking uses the same patterns. */
export const containsSecret = (text: string, passwords: ReadonlyArray<string> = []) =>
  redactText(text, passwords) !== text;

/** Includes property names: DOM attributes and evaluate results can hide secrets in keys. */
export const redactPreview = <A>(value: A, passwords: ReadonlyArray<string> = []): A => {
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return redactText(current, passwords);
    if (Array.isArray(current)) return current.map(walk);
    if (typeof current !== "object" || current === null) return current;
    const record = current as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        redactText(key, passwords),
        /secret|token|api[-_]?key|authorization|credential|passwd|password|client_secret/i.test(
          key,
        ) ||
        (key === "value" && (record.type === "password" || record.inputType === "password"))
          ? SECRET_REDACTED
          : // Images are binary artifacts, not DOM strings. ScreenshotMask masks
            // credentials in the page before capture instead.
            key === "screenshot"
            ? entry
            : walk(entry),
      ]),
    );
  };
  return walk(value) as A;
};

/** Keep the possible start of a credential across arbitrary chunks, including newlines. */
export const createOutputRedactor = (secrets: ReadonlyArray<string>) => {
  const values = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
          Buffer.from(secret).toString("base64"),
        ]),
    ),
  ].toSorted((a, b) => b.length - a.length);
  const longest = Math.max(1, ...values.map((value) => value.length));
  let pending = "";
  const drain = (final: boolean) => {
    const limit = final ? pending.length : Math.max(0, pending.length - longest + 1);
    let result = "";
    let offset = 0;
    while (offset < limit) {
      const matched = values.find((value) => pending.startsWith(value, offset));
      if (matched) {
        result += "[redacted]";
        offset += matched.length;
      } else if (final && values.some((value) => value.startsWith(pending.slice(offset)))) {
        result += "[redacted]";
        offset = pending.length;
      } else {
        result += pending[offset++];
      }
    }
    pending = pending.slice(offset);
    return result;
  };
  return {
    push: (chunk: string) => {
      pending += chunk;
      return drain(false);
    },
    flush: () => drain(true),
  };
};

import * as Effect from "effect/Effect";

/** Route virtual HTTPS endpoints to in-process HTTP fixtures at the network boundary. */
export const loopbackHttpsFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.protocol === "https:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    url.protocol = "http:";
  return globalThis.fetch(input instanceof Request ? new Request(url, input) : url, init);
};

export const loopbackHttpsPolicy = (raw: string) => {
  const url = new URL(raw);
  return Effect.succeed(
    url.protocol === "https:" && ["127.0.0.1", "localhost"].includes(url.hostname)
      ? loopbackHttpsFetch
      : undefined,
  );
};

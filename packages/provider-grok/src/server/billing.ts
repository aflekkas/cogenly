/**
 * Grok subscription limits. Grok has no rate-limit headers; its CLI reads
 * billing from xAI's CLI proxy. Cogenly asks the running ACP host first
 * (`_x.ai/billing`, so the CLI owns auth and refresh), then the same endpoint
 * over HTTP with the CLI's cached token, read-only. Every field is optional:
 * the shape comes from the CLI's own client and is not a published API.
 *
 * @module provider-grok/server/billing
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Numbers arrive as JSON numbers, decimal strings, or `{ val }` wrappers. */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const wrapped = asRecord(value);
  if (wrapped && "val" in wrapped) return readNumber(wrapped.val);
  return undefined;
}

/** Times arrive as ISO strings, epoch seconds or millis, or `{ seconds }` timestamps. */
export function readGrokTimestampMs(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return readGrokTimestampMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  const record = asRecord(value);
  if (record && "seconds" in record) {
    const seconds = readNumber(record.seconds);
    const nanos = readNumber(record.nanos) ?? 0;
    return seconds === undefined ? undefined : Math.round(seconds * 1000 + nanos / 1e6);
  }
  return undefined;
}

const percent = (value: number) => Math.min(100, Math.max(0, value));
const iso = (ms: number | undefined) =>
  ms === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Builds the limit bars from a billing response (`{ config: {...} }` or the
 * config itself). A weekly pool shows `creditUsagePercent`; a monthly limit
 * shows `used / monthlyLimit`. A period with no usage figure reads as
 * unavailable with its reset time; undefined when the response names no period.
 */
export function parseGrokBilling(
  value: unknown,
  checkedAtMs: number,
): ServerProviderUsageLimits | undefined {
  const root = asRecord(value);
  const config = asRecord(root?.config) ?? root;
  if (!config) return undefined;
  const period = asRecord(config.currentPeriod);
  const periodType = typeof period?.type === "string" ? period.type : undefined;
  const periodEnd =
    readGrokTimestampMs(period?.end) ?? readGrokTimestampMs(config.billingPeriodEnd);
  const usagePercent = readNumber(config.creditUsagePercent);
  const monthlyLimit = readNumber(config.monthlyLimit);
  const used = readNumber(config.used);
  const windows: Array<ServerProviderUsageWindow> = [];

  if (usagePercent !== undefined && periodType?.includes("WEEKLY")) {
    const resetsAt = iso(periodEnd);
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: percent(usagePercent),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: 7 * 24 * 60,
    });
  }
  const monthlyPercent =
    monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined
      ? (used / monthlyLimit) * 100
      : usagePercent !== undefined && periodType?.includes("MONTHLY")
        ? usagePercent
        : undefined;
  if (monthlyPercent !== undefined) {
    const resetsAt = iso(readGrokTimestampMs(config.billingPeriodEnd) ?? periodEnd);
    windows.push({
      id: "monthly",
      kind: "monthly",
      label: "Monthly",
      usedPercent: percent(monthlyPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  // A pool of an unrecognised period still has a usage percentage worth showing.
  if (windows.length === 0 && usagePercent !== undefined) {
    const resetsAt = iso(periodEnd);
    windows.push({
      id: "usage",
      kind: "other",
      label: "Usage",
      usedPercent: percent(usagePercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(checkedAtMs));
  if (windows.length > 0) return { checkedAt, windows };
  // A period with no usage figure yet (a fresh week, or the free tier): a bar
  // needs a percentage, so say when the pool resets instead of guessing 0%.
  if (periodType !== undefined) {
    const resetsAt = periodEnd === undefined ? undefined : iso(periodEnd);
    return {
      checkedAt,
      windows: [],
      unavailable: {
        reason: "probeFailed",
        message: resetsAt
          ? `Grok hasn't reported usage for this period yet. It resets ${resetsAt}.`
          : "Grok hasn't reported usage for this period yet.",
      },
    };
  }
  return undefined;
}

/** The CLI proxy's billing endpoints, most specific first. */
export const GROK_BILLING_URLS = [
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
  "https://cli-chat-proxy.grok.com/v1/billing",
] as const;

/** The ACP extension method Grok 1.0.67 answers billing on (`x.ai/billing` is -32601). */
export const GROK_BILLING_ACP_METHODS = ["_x.ai/billing"] as const;

/** The cached CLI login in `~/.grok/auth.json`: the first `https://auth.x.ai::…` entry. */
export interface GrokCachedToken {
  readonly key: string;
  readonly expiresAtMs: number | undefined;
  readonly email: string | undefined;
}

/** Reads the CLI's cached token without refreshing it. */
export function parseGrokAuthFile(raw: string): GrokCachedToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (!root) return undefined;
  for (const [name, value] of Object.entries(root)) {
    if (!name.startsWith("https://auth.x.ai")) continue;
    const entry = asRecord(value);
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key) continue;
    const email = [entry?.email, asRecord(entry?.user)?.email, asRecord(entry?.account)?.email]
      .find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.includes("@"),
      )
      ?.trim();
    return {
      key,
      expiresAtMs: readGrokTimestampMs(entry?.expires_at ?? entry?.expiresAt),
      email: email ?? emailFromJwt(key),
    };
  }
  return undefined;
}

/** The `email` claim of a JWT access token, when the token is one. */
function emailFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const email = claims?.email;
    return typeof email === "string" && email.includes("@") ? email : undefined;
  } catch {
    return undefined;
  }
}

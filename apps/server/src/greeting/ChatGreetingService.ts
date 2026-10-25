/**
 * ChatGreetingService - the new-chat greeting written by the text generation
 * model from what the user has been working on.
 *
 * At most one greeting per local day and time-of-day bucket (morning,
 * afternoon, evening), plus a rolling daily cap, so a busy day costs about
 * three small calls. Results and failed attempts are persisted in the state
 * directory, so reloads, other clients, and restarts reuse them. The prompt
 * carries only a handful of recent thread and project titles plus the
 * weekday and time of day: no message bodies.
 *
 * @module greeting/ChatGreetingService
 */
import type { ChatGreetingBucket, ChatGreetingInput, ChatGreetingResult } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const HOUR_MS = 60 * 60 * 1_000;
/** Buckets that get a written greeting; late night keeps the built-in lines. */
const GENERATED_BUCKETS: ReadonlySet<ChatGreetingBucket> = new Set([
  "morning",
  "afternoon",
  "evening",
]);
/** Attempts per rolling day. One above the bucket count leaves room for a time zone change. */
export const MAX_GREETING_ATTEMPTS_PER_DAY = 4;
/** How far back "recent work" reaches, and how many titles the prompt carries. */
const ACTIVITY_WINDOW_MS = 24 * HOUR_MS;
const ACTIVITY_THREAD_LIMIT = 6;
const MAX_GREETING_CHARS = 80;
/** Entries kept on disk: a couple of days of buckets. */
const MAX_STORED_ENTRIES = 12;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const BUCKET_LABELS: Record<ChatGreetingBucket, string> = {
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
  lateNight: "late at night",
};

const GreetingEntry = Schema.Struct({
  key: Schema.String,
  /** Null records a failed or empty attempt, so the bucket is not retried. */
  text: Schema.NullOr(Schema.String),
  /** Server clock, epoch millis. */
  at: Schema.Number,
});
export type GreetingEntry = typeof GreetingEntry.Type;
const GreetingCacheFile = Schema.Struct({ entries: Schema.Array(GreetingEntry) });
const decodeCacheFile = Schema.decodeUnknownOption(Schema.fromJsonString(GreetingCacheFile));
const encodeCacheFile = Schema.encodeSync(Schema.fromJsonString(GreetingCacheFile));

export const greetingKey = (input: Pick<ChatGreetingInput, "day" | "bucket">) =>
  `${input.day}:${input.bucket}`;

type GreetingDecision =
  | { readonly type: "cached"; readonly text: string | null }
  | { readonly type: "generate" }
  | { readonly type: "skip" };

/**
 * What to do for one request. Disabled, late-night, implausible days, and a
 * spent daily budget all fall back to the built-in greeting; a bucket that was
 * already attempted answers from its entry, even when that attempt failed.
 */
export function decideGreeting(input: {
  readonly enabled: boolean;
  readonly request: Pick<ChatGreetingInput, "day" | "bucket">;
  readonly entries: ReadonlyArray<GreetingEntry>;
  readonly nowMs: number;
}): GreetingDecision {
  if (!input.enabled) return { type: "skip" };
  const key = greetingKey(input.request);
  const entry = input.entries.find((candidate) => candidate.key === key);
  if (entry) return { type: "cached", text: entry.text };
  if (!GENERATED_BUCKETS.has(input.request.bucket)) return { type: "skip" };
  // A local date is within about a day of the server's clock in any time zone;
  // anything else is a skewed or replayed client that must not buy new calls.
  const dayNoon = Date.parse(`${input.request.day}T12:00:00Z`);
  if (!Number.isFinite(dayNoon) || Math.abs(dayNoon - input.nowMs) > 27 * HOUR_MS) {
    return { type: "skip" };
  }
  const recent = input.entries.filter((candidate) => input.nowMs - candidate.at < 24 * HOUR_MS);
  if (recent.length >= MAX_GREETING_ATTEMPTS_PER_DAY) return { type: "skip" };
  return { type: "generate" };
}

/** Adds or replaces one entry, keeping only the newest few. */
export function rememberGreeting(
  entries: ReadonlyArray<GreetingEntry>,
  entry: GreetingEntry,
): ReadonlyArray<GreetingEntry> {
  return [...entries.filter((candidate) => candidate.key !== entry.key), entry]
    .toSorted((left, right) => left.at - right.at)
    .slice(-MAX_STORED_ENTRIES);
}

/** One clean line from the model, or null when it is empty or too long to show. */
export function cleanGreeting(raw: string): string | null {
  const line = (raw.split("\n").find((candidate) => candidate.trim().length > 0) ?? "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length === 0 || line.length > MAX_GREETING_CHARS ? null : line;
}

/** The prompt's activity data: unique thread titles and the projects they belong to. */
export function summarizeRecentWork(
  rows: ReadonlyArray<{ readonly title: string; readonly projectTitle: string | null }>,
): { readonly threads: ReadonlyArray<string>; readonly projects: ReadonlyArray<string> } {
  const threads = new Set<string>();
  const projects = new Set<string>();
  for (const row of rows) {
    const title = row.title.trim();
    if (title.length > 0 && title !== "New thread") threads.add(title.slice(0, 80));
    const project = row.projectTitle?.trim();
    if (project) projects.add(project.slice(0, 60));
  }
  return { threads: [...threads], projects: [...projects] };
}

export class ChatGreetingService extends Context.Service<
  ChatGreetingService,
  {
    /** The greeting for the client's day and bucket. Never fails; null means the built-in line. */
    readonly get: (input: ChatGreetingInput) => Effect.Effect<ChatGreetingResult>;
  }
>()("cogenly-server/greeting/ChatGreetingService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Generations outlive the request that started them, so a closed tab still
  // fills the cache for the next one.
  const serviceScope = yield* Effect.scope;
  const cachePath = path.join(config.stateDir, "chat-greetings.json");
  const entriesRef = yield* Ref.make<ReadonlyArray<GreetingEntry> | null>(null);
  const inFlight = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<string | null>>>(
    new Map(),
  );
  // Deciding and starting a generation is one step, so concurrent clients share it.
  const lock = yield* Semaphore.make(1);

  const loadEntries = Effect.gen(function* () {
    const loaded = yield* Ref.get(entriesRef);
    if (loaded !== null) return loaded;
    const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.orElseSucceed(() => ""));
    const entries = Option.match(decodeCacheFile(raw), {
      onNone: (): ReadonlyArray<GreetingEntry> => [],
      onSome: (file) => file.entries,
    });
    yield* Ref.set(entriesRef, entries);
    return entries;
  });

  const record = (entry: GreetingEntry) =>
    Effect.gen(function* () {
      const entries = rememberGreeting(yield* loadEntries, entry);
      yield* Ref.set(entriesRef, entries);
      yield* writeFileStringAtomically({
        filePath: cachePath,
        contents: encodeCacheFile({ entries }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) => Effect.logWarning("Could not save chat greetings", { cause })),
      );
    }).pipe(lock.withPermits(1));

  const clearInFlight = (key: string) =>
    Ref.update(inFlight, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });

  const generate = Effect.fn("ChatGreetingService.generate")(function* (input: {
    readonly key: string;
    readonly request: ChatGreetingInput;
    readonly recentWork: ReturnType<typeof summarizeRecentWork>;
    readonly deferred: Deferred.Deferred<string | null>;
  }) {
    const text = yield* settingsService.getSettings.pipe(
      Effect.flatMap((settings) =>
        textGeneration.generateGreeting({
          cwd: config.stateDir,
          weekday: WEEKDAYS[input.request.weekday] ?? "today",
          timeOfDay: BUCKET_LABELS[input.request.bucket],
          recentWork: JSON.stringify(input.recentWork),
          modelSelection: settings.textGenerationModelSelection,
        }),
      ),
      Effect.map((result) => cleanGreeting(result.greeting)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Chat greeting generation failed", { cause }).pipe(Effect.as(null)),
      ),
    );
    yield* record({ key: input.key, text, at: yield* Clock.currentTimeMillis });
    // Clear the in-flight marker before waking waiters, so their next request reads the cache.
    yield* clearInFlight(input.key);
    yield* Deferred.succeed(input.deferred, text);
  });

  const start = Effect.fn("ChatGreetingService.start")(function* (request: ChatGreetingInput) {
    const key = greetingKey(request);
    const running = (yield* Ref.get(inFlight)).get(key);
    if (running) return { type: "pending" as const, deferred: running };
    const enabled = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.aiGreetings),
      Effect.orElseSucceed(() => false),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const decision = decideGreeting({ enabled, request, entries: yield* loadEntries, nowMs });
    if (decision.type === "cached") return { type: "done" as const, text: decision.text };
    if (decision.type === "skip") return { type: "done" as const, text: null };
    // Nothing to talk about: the built-in line is better, and costs nothing.
    const recentWork = summarizeRecentWork(
      yield* projections
        .getRecentThreadTitles({
          since: DateTime.makeUnsafe(nowMs - ACTIVITY_WINDOW_MS),
          limit: ACTIVITY_THREAD_LIMIT,
        })
        .pipe(Effect.orElseSucceed(() => [])),
    );
    if (recentWork.threads.length === 0) return { type: "done" as const, text: null };
    const deferred = yield* Deferred.make<string | null>();
    yield* Ref.update(inFlight, (map) => new Map(map).set(key, deferred));
    yield* generate({ key, request, recentWork, deferred }).pipe(
      Effect.ensuring(clearInFlight(key)),
      // Never leave a waiting client hanging, even on a defect.
      Effect.onExit(() => Deferred.succeed(deferred, null)),
      Effect.forkIn(serviceScope),
    );
    return { type: "pending" as const, deferred };
  });

  const get: ChatGreetingService["Service"]["get"] = Effect.fn("ChatGreetingService.get")(
    function* (input) {
      const outcome = yield* start(input).pipe(lock.withPermits(1));
      if (outcome.type === "done") return { text: outcome.text, pending: false };
      if (input.awaitGeneration !== true) return { text: null, pending: true };
      return { text: yield* Deferred.await(outcome.deferred), pending: false };
    },
  );

  return ChatGreetingService.of({ get });
});

export const layer = Layer.effect(ChatGreetingService, make);

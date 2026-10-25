import {
  RepoMcpTrustError,
  RepoMcpTrustPrompt,
  type RepoMcpTrustRespondInput,
  type ThreadId,
} from "@cogenly/contracts";
import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Crypto exposes randomness but no stable hash for definition consent.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProcessRunner from "../processRunner.ts";
import { normalizeRepositoryRemote } from "../project/RepositoryRemote.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Servers = RepoMcpTrustPrompt.fields.servers;
const encodeServers = Schema.encodeSync(Schema.fromJsonString(Servers));
const decodeServers = Schema.decodeUnknownEffect(Schema.fromJsonString(Servers));
const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);
const Command = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
});
const decodeCommand = Schema.decodeUnknownOption(Command);
const isTrustError = Schema.is(RepoMcpTrustError);
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, sorted(value)]),
        )
      : value;
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export class RepoMcpTrust extends Context.Service<
  RepoMcpTrust,
  {
    readonly review: (input: {
      readonly cwd: string;
      readonly threadId?: ThreadId | undefined;
      readonly definitions: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<
      {
        readonly allowedNames: ReadonlyArray<string>;
        readonly waitingNames: ReadonlyArray<string>;
      },
      RepoMcpTrustError
    >;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<{ readonly prompts: ReadonlyArray<RepoMcpTrustPrompt> }, RepoMcpTrustError>;
    readonly respond: (input: RepoMcpTrustRespondInput) => Effect.Effect<void, RepoMcpTrustError>;
  }
>()("cogenly-server/integrations/RepoMcpTrust") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const github = yield* Effect.serviceOption(GitHubRest.GitHubRest);
  const changes = yield* PubSub.unbounded<void>();
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const storage = (cause: unknown) =>
    isTrustError(cause) ? cause : new RepoMcpTrustError({ reason: "storage", cause });
  const list = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: string;
        remote: string;
        decision: RepoMcpTrustPrompt["decision"];
        servers_json: string;
      }>`SELECT t.id,t.remote,t.decision,p.servers_json FROM repo_mcp_trust t JOIN repo_mcp_trust_prompts p ON p.trust_id=t.id WHERE p.thread_id=${threadId} ORDER BY t.id`;
      return {
        prompts: yield* Effect.forEach(rows, (row) =>
          decodeServers(row.servers_json).pipe(
            Effect.map((servers) => ({
              id: row.id,
              remote: row.remote,
              decision: row.decision,
              servers,
            })),
          ),
        ),
      };
    }).pipe(Effect.mapError(storage));
  const clearPrompts = (threadId: ThreadId | undefined, keepId?: string) =>
    threadId === undefined
      ? Effect.void
      : sql`DELETE FROM repo_mcp_trust_prompts WHERE thread_id=${threadId} AND (${keepId ?? null} IS NULL OR trust_id<>${keepId ?? null}) RETURNING trust_id`.pipe(
          Effect.flatMap((removed) => (removed.length > 0 ? notify : Effect.void)),
        );
  return RepoMcpTrust.of({
    review: (input) =>
      Effect.gen(function* () {
        const commands = Object.entries(input.definitions).flatMap(([name, definition]) => {
          const command = decodeCommand(definition);
          return Option.isNone(command)
            ? []
            : [{ name, command: command.value.command, args: [...(command.value.args ?? [])] }];
        });
        const names = Object.keys(input.definitions);
        const commandNames = new Set(commands.map((server) => server.name));
        if (commands.length === 0) {
          yield* clearPrompts(input.threadId);
          return { allowedNames: names, waitingNames: [] };
        }
        // Git errors must not be confused with a repository that really has no remotes.
        const result = yield* runner
          .run({ command: "git", args: ["-C", input.cwd, "remote", "-v"], timeout: "5 seconds" })
          .pipe(
            Effect.mapError(
              (cause) => new RepoMcpTrustError({ reason: "repository_unavailable", cause }),
            ),
          );
        if (result.code !== 0)
          return yield* new RepoMcpTrustError({ reason: "repository_unavailable" });
        const remotes = result.stdout.split("\n").flatMap((line) => {
          const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
          return match ? [{ name: match[1]!, url: match[2]! }] : [];
        });
        if (result.stdout.trim() === "") {
          yield* clearPrompts(input.threadId);
          return { allowedNames: names, waitingNames: [] };
        }
        const primary =
          remotes.find((remote) => remote.name === "origin") ??
          remotes.toSorted((a, b) => a.name.localeCompare(b.name))[0];
        if (primary === undefined)
          return yield* new RepoMcpTrustError({ reason: "repository_unavailable" });
        const remote =
          normalizeRepositoryRemote(primary.url) ?? `private-remote:${hash(primary.url)}`;
        const linked = yield* sql<{
          owner: string;
        }>`SELECT DISTINCT owner FROM label_source_links WHERE kind='github-owner'`;
        const owners = new Set(linked.map(({ owner }) => owner.toLowerCase()));
        const [host, owner] = remote.split("/");
        if (host === "github.com" && owner !== undefined && owners.has(owner.toLowerCase())) {
          yield* clearPrompts(input.threadId);
          return { allowedNames: names, waitingNames: [] };
        }
        if (Option.isSome(github)) {
          const response = yield* github.value
            .rest({
              host: "github.com",
              operation: "repoMcpTrust",
              path: "user",
              timeout: "5 seconds",
            })
            .pipe(Effect.option);
          if (Option.isSome(response) && response.value.status === 200) {
            const viewer = decodeViewer(response.value.body);
            if (Option.isSome(viewer)) owners.add(viewer.value.login.toLowerCase());
          }
        }
        if (host === "github.com" && owner !== undefined && owners.has(owner.toLowerCase())) {
          yield* clearPrompts(input.threadId);
          return { allowedNames: names, waitingNames: [] };
        }
        const definitionHash = hash(encodeJson(sorted(input.definitions)));
        const id = `repo-mcp:${hash(`${remote}\u0000${definitionHash}`)}`;
        yield* clearPrompts(input.threadId, id);
        let inserted = false;
        const trusted = yield* Effect.gen(function* () {
          const found = yield* sql<{
            decision: string;
          }>`SELECT decision FROM repo_mcp_trust WHERE id=${id}`;
          if (found[0]?.decision === "trusted") return true;
          if (found[0]?.decision === "denied") return false;
          yield* sql`INSERT INTO repo_mcp_trust(id,remote,definition_hash,decision) VALUES (${id},${remote},${definitionHash},'pending') ON CONFLICT DO NOTHING`;
          if (input.threadId !== undefined) {
            // Only names and argv go into the prompt. Environment values remain private.
            const previous =
              yield* sql`SELECT 1 FROM repo_mcp_trust_prompts WHERE trust_id=${id} AND thread_id=${input.threadId}`;
            if (previous.length === 0) {
              yield* sql`INSERT INTO repo_mcp_trust_prompts(trust_id,thread_id,servers_json) VALUES (${id},${input.threadId},${encodeServers(commands)}) ON CONFLICT DO NOTHING`;
              inserted = true;
            }
          }
          return false;
        }).pipe(sql.withTransaction);
        if (inserted) yield* notify;
        return {
          allowedNames: trusted ? names : names.filter((name) => !commandNames.has(name)),
          waitingNames: trusted ? [] : [...commandNames],
        };
      }).pipe(Effect.mapError(storage)),
    subscribe: (threadId) =>
      Stream.mergeAll([Stream.make(undefined), Stream.fromPubSub(changes)], {
        concurrency: "unbounded",
      }).pipe(Stream.mapEffect(() => list(threadId))),
    respond: (input) =>
      Effect.gen(function* () {
        const found =
          yield* sql`SELECT 1 FROM repo_mcp_trust_prompts p JOIN repo_mcp_trust t ON t.id=p.trust_id WHERE p.trust_id=${input.id} AND p.thread_id=${input.threadId}`;
        if (found.length === 0) return yield* new RepoMcpTrustError({ reason: "not_found" });
        yield* sql`UPDATE repo_mcp_trust SET decision=${input.trust ? "trusted" : "denied"} WHERE id=${input.id}`;
      }).pipe(sql.withTransaction, Effect.mapError(storage), Effect.andThen(notify)),
  });
});

export const layer = Layer.effect(RepoMcpTrust, make);

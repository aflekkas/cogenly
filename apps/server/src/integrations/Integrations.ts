import {
  Integration,
  IntegrationError,
  IntegrationId,
  type IntegrationCallResult,
  type IntegrationCreateInput,
  type IntegrationListResult,
  type IntegrationName,
  type IntegrationSummary,
  type IntegrationTestResult,
  type IntegrationToolsResult,
  type IntegrationUpdateInput,
  type ProjectLabelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Credentials from "./IntegrationCredentials.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Integration));
const encode = Schema.encodeEffect(Schema.fromJsonString(Integration));
const isError = Schema.is(IntegrationError);
const failure =
  (operation: string, reason: IntegrationError["reason"]) =>
  (cause: unknown): IntegrationError =>
    isError(cause) ? cause : new IntegrationError({ operation, reason, cause });

export const DEFAULT_TOOL_CACHE_TTL_MS = 60_000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

const CREDENTIAL_REF = /\{\{credential:([^}]*)\}\}/g;

/** Credential references referenced by a header template, in order. */
export const credentialRefsIn = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(CREDENTIAL_REF)].map((match) => (match[1] ?? "").trim());

/**
 * Resolves `{{credential:item.field}}` references in every header value.
 * Fails closed: an unknown template, a malformed reference, or a missing
 * credential fails the whole resolution and no headers are produced.
 */
export const resolveHeaderTemplates = (
  headers: Readonly<Record<string, string>>,
  resolve: (
    ref: string,
  ) => Effect.Effect<Option.Option<string>, Credentials.IntegrationCredentialError>,
): Effect.Effect<Record<string, string>, IntegrationError> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, template] of Object.entries(headers)) {
      if (template.includes("{{") && credentialRefsIn(template).length === 0) {
        return yield* new IntegrationError({
          operation: "resolve credentials",
          reason: "credential_unresolved",
        });
      }
      let value = template;
      for (const ref of credentialRefsIn(template)) {
        if (Credentials.parseCredentialRef(ref) === undefined) {
          return yield* new IntegrationError({
            operation: "resolve credentials",
            reason: "credential_unresolved",
          });
        }
        const secret = yield* resolve(ref).pipe(
          Effect.mapError(
            () =>
              new IntegrationError({
                operation: "resolve credentials",
                reason: "credential_unresolved",
              }),
          ),
        );
        if (Option.isNone(secret)) {
          return yield* new IntegrationError({
            operation: "resolve credentials",
            reason: "credential_unresolved",
          });
        }
        value = value.replaceAll(`{{credential:${ref}}}`, secret.value);
      }
      resolved[name] = value;
    }
    return resolved;
  });

/**
 * Whether an integration is usable from a project. `null` means the caller
 * has no project (only all-project integrations), a label id scopes to that
 * project, and `undefined` means an unrestricted owner view (settings, MCP
 * clients signed in from outside a thread).
 */
export const integrationVisibleTo = (
  integration: Integration,
  labelId: ProjectLabelId | null | undefined,
): boolean =>
  integration.deletedAt === null &&
  integration.enabled &&
  (labelId === undefined ||
    integration.scope.type === "all" ||
    (labelId !== null && integration.scope.labelIds.includes(labelId)));

interface CachedTools {
  readonly key: string;
  readonly atMs: number;
  readonly result: IntegrationToolsResult;
}

export interface IntegrationsOptions {
  readonly toolCacheTtlMs?: number;
  readonly upstreamTimeoutMs?: number;
}

export class Integrations extends Context.Service<
  Integrations,
  {
    /** Every live integration, unscoped (settings/client view). */
    readonly list: () => Effect.Effect<IntegrationListResult, IntegrationError>;
    /** Live integrations usable from one project (null = no project). */
    readonly listForProject: (
      labelId: ProjectLabelId | null,
    ) => Effect.Effect<IntegrationListResult, IntegrationError>;
    readonly create: (
      input: IntegrationCreateInput,
    ) => Effect.Effect<{ integration: Integration }, IntegrationError>;
    readonly update: (
      input: IntegrationUpdateInput,
    ) => Effect.Effect<{ integration: Integration }, IntegrationError>;
    /** Tombstones the integration; its name becomes reusable. */
    readonly remove: (id: IntegrationId) => Effect.Effect<{ deleted: boolean }, IntegrationError>;
    readonly testConnection: (
      id: IntegrationId,
    ) => Effect.Effect<IntegrationTestResult, IntegrationError>;
    readonly listTools: (
      name: IntegrationName,
      labelId: ProjectLabelId | null | undefined,
    ) => Effect.Effect<IntegrationToolsResult, IntegrationError>;
    readonly callTool: (
      name: IntegrationName,
      tool: string,
      args: unknown,
      labelId: ProjectLabelId | null | undefined,
    ) => Effect.Effect<IntegrationCallResult, IntegrationError>;
    /** Enabled integrations visible from a project, for the context line. */
    readonly contextIntegrations: (
      labelId: ProjectLabelId | null,
    ) => Effect.Effect<ReadonlyArray<Integration>, IntegrationError>;
  }
>()("cogenly-server/integrations/Integrations") {}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

const parseRpcBody = (text: string): JsonRpcResponse | undefined => {
  const trimmed = text.trim();
  const candidates = trimmed.startsWith("data:")
    ? trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
    : [trimmed];
  for (const candidate of candidates.toReversed()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) return parsed as JsonRpcResponse;
    } catch {
      // Try the next SSE event; a body with no JSON is handled by the caller.
    }
  }
  return undefined;
};

const make = (options: IntegrationsOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials.IntegrationCredentials;
    const ttlMs = options.toolCacheTtlMs ?? DEFAULT_TOOL_CACHE_TTL_MS;
    const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const cache = yield* Ref.make(new Map<string, CachedTools>());
    const requestIds = yield* Ref.make(0);
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const invalidate = (id: IntegrationId) =>
      Ref.update(cache, (entries) => {
        const next = new Map(entries);
        for (const key of next.keys()) if (key.startsWith(`${id}:`)) next.delete(key);
        return next;
      });

    const rows = () =>
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE deleted_at IS NULL ORDER BY name`.pipe(
        Effect.flatMap((found) =>
          Effect.forEach(found, (row) =>
            decode(row.payload_json).pipe(Effect.mapError(failure("list", "storage"))),
          ),
        ),
        Effect.mapError(failure("list", "storage")),
      );

    const getById = (id: IntegrationId) =>
      Effect.gen(function* () {
        const found = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM integrations WHERE id = ${id} AND deleted_at IS NULL`.pipe(
          Effect.mapError(failure("read", "storage")),
        );
        if (!found[0]) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        return yield* decode(found[0].payload_json).pipe(
          Effect.mapError(failure("read", "storage")),
        );
      });

    const getByName = (name: IntegrationName, labelId: ProjectLabelId | null | undefined) =>
      Effect.gen(function* () {
        const all = yield* rows();
        const found = all.find((integration) => integration.name === name);
        if (found === undefined) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        if (!found.enabled) {
          return yield* new IntegrationError({ operation: "read", reason: "disabled" });
        }
        if (!integrationVisibleTo(found, labelId)) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        return found;
      });

    const summaries = (integrations: ReadonlyArray<Integration>) =>
      Effect.gen(function* () {
        const entries = yield* Ref.get(cache);
        return {
          integrations: integrations.map((integration) => {
            const cached = entries.get(`${integration.id}:${integration.updatedAt}`);
            return {
              integration,
              status: cached === undefined ? "unknown" : "connected",
              toolCount: cached === undefined ? null : cached.result.tools.length,
            } satisfies IntegrationSummary;
          }),
        };
      });

    const post = (
      integration: Integration,
      headers: Record<string, string>,
      method: string,
      params: unknown,
      sessionId: string | undefined,
    ) =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(requestIds, (value) => value + 1);
        let request = HttpClientRequest.post(integration.url).pipe(
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
        for (const [name, value] of Object.entries(headers)) {
          request = HttpClientRequest.setHeader(request, name, value);
        }
        if (sessionId !== undefined) {
          request = HttpClientRequest.setHeader(request, "mcp-session-id", sessionId);
        }
        const response = yield* client.execute(request).pipe(
          Effect.timeout(Duration.millis(timeoutMs)),
          Effect.mapError((cause) =>
            isError(cause)
              ? cause
              : typeof cause === "object" &&
                  cause !== null &&
                  "_tag" in cause &&
                  cause._tag === "TimeoutError"
                ? new IntegrationError({ operation: method, reason: "upstream_timeout" })
                : new IntegrationError({
                    operation: method,
                    reason: "upstream_unreachable",
                    cause,
                  }),
          ),
        );
        const text = yield* response.text.pipe(
          Effect.mapError(
            (cause) => new IntegrationError({ operation: method, reason: "upstream_error", cause }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
          });
        }
        const body = parseRpcBody(text);
        if (body === undefined) {
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
          });
        }
        if (body.error !== undefined) {
          const message =
            typeof body.error.message === "string"
              ? body.error.message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS)
              : "Upstream MCP error";
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
            cause: message,
          });
        }
        return {
          result: body.result,
          sessionId: response.headers["mcp-session-id"] ?? sessionId,
        };
      });

    /** One upstream round trip: resolve credentials, handshake, then call. */
    const rpc = (integration: Integration, method: string, params: unknown) =>
      Effect.gen(function* () {
        const headers = yield* resolveHeaderTemplates(integration.headers, credentials.resolve);
        const initialized = yield* post(
          integration,
          headers,
          "initialize",
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "cogenly", version: "1" },
          },
          undefined,
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        return yield* post(integration, headers, method, params, initialized?.sessionId).pipe(
          Effect.map((response) => response.result),
        );
      });

    const fetchTools = (integration: Integration) =>
      rpc(integration, "tools/list", {}).pipe(
        Effect.flatMap((result) => {
          const tools =
            typeof result === "object" && result !== null && "tools" in result
              ? (result as { tools: unknown }).tools
              : undefined;
          if (!Array.isArray(tools)) {
            return Effect.fail(
              new IntegrationError({ operation: "tools/list", reason: "upstream_error" }),
            );
          }
          return Effect.succeed({
            name: integration.name,
            tools: tools.flatMap((tool) => {
              if (typeof tool !== "object" || tool === null || !("name" in tool)) return [];
              const record = tool as Record<string, unknown>;
              return [
                {
                  name: String(record.name),
                  description: typeof record.description === "string" ? record.description : "",
                  inputSchema: record.inputSchema ?? {},
                },
              ];
            }),
          } satisfies IntegrationToolsResult);
        }),
      );

    const listTools = (
      name: IntegrationName,
      labelId: ProjectLabelId | null | undefined,
      force = false,
    ) =>
      Effect.gen(function* () {
        const integration = yield* getByName(name, labelId);
        const key = `${integration.id}:${integration.updatedAt}`;
        if (!force) {
          const entries = yield* Ref.get(cache);
          const cached = entries.get(key);
          const at = yield* Clock.currentTimeMillis;
          if (cached !== undefined && at - cached.atMs < ttlMs) return cached.result;
        }
        const result = yield* fetchTools(integration);
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.update(cache, (entries) => new Map(entries).set(key, { key, atMs: at, result }));
        return result;
      });

    const validateUrl = (url: string) =>
      Effect.try({
        try: () => new URL(url),
        catch: () => new IntegrationError({ operation: "validate", reason: "invalid_request" }),
      }).pipe(
        Effect.flatMap((parsed) =>
          parsed.protocol === "http:" || parsed.protocol === "https:"
            ? Effect.void
            : Effect.fail(
                new IntegrationError({ operation: "validate", reason: "invalid_request" }),
              ),
        ),
      );

    const persist = (integration: Integration) =>
      encode(integration).pipe(
        Effect.flatMap(
          (payload) =>
            sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES (${integration.id}, ${integration.name}, ${payload}, ${integration.deletedAt}, ${integration.updatedAt}) ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
        ),
        Effect.mapError(failure("write", "storage")),
      );

    return Integrations.of({
      list: () => rows().pipe(Effect.flatMap(summaries)),
      listForProject: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) => integrationVisibleTo(integration, labelId)),
          ),
          Effect.flatMap(summaries),
        ),
      create: (input) =>
        Effect.gen(function* () {
          yield* validateUrl(input.url);
          for (const template of Object.values(input.headers)) {
            for (const ref of credentialRefsIn(template)) {
              if (Credentials.parseCredentialRef(ref) === undefined) {
                return yield* new IntegrationError({
                  operation: "create",
                  reason: "credential_unresolved",
                });
              }
            }
          }
          const existing = yield* rows();
          if (existing.some((integration) => integration.name === input.name)) {
            return yield* new IntegrationError({ operation: "create", reason: "conflict" });
          }
          const at = yield* now;
          const integration: Integration = {
            id: IntegrationId.make(
              `integration:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure("create", "storage")))}`,
            ),
            name: input.name,
            displayName: input.displayName,
            transport: input.transport,
            url: input.url,
            headers: input.headers,
            enabled: input.enabled ?? true,
            scope: input.scope,
            hint: input.hint,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          };
          yield* persist(integration);
          return { integration };
        }).pipe(Effect.mapError(failure("create", "storage"))),
      update: (input) =>
        Effect.gen(function* () {
          const current = yield* getById(input.id);
          if (input.url !== undefined) yield* validateUrl(input.url);
          const integration: Integration = {
            ...current,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.hint === undefined ? {} : { hint: input.hint }),
            updatedAt: yield* now,
          };
          yield* persist(integration);
          yield* invalidate(integration.id);
          return { integration };
        }).pipe(Effect.mapError(failure("update", "storage"))),
      remove: (id) =>
        Effect.gen(function* () {
          const current = yield* getById(id).pipe(
            Effect.catchTags({
              IntegrationError: (error) =>
                error.reason === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
            }),
          );
          if (current === undefined) return { deleted: false };
          const at = yield* now;
          yield* persist({ ...current, deletedAt: at, updatedAt: at });
          yield* invalidate(id);
          return { deleted: true };
        }).pipe(Effect.mapError(failure("delete", "storage"))),
      testConnection: (id) =>
        Effect.gen(function* () {
          const integration = yield* getById(id);
          if (!integration.enabled) {
            return yield* new IntegrationError({
              operation: "test connection",
              reason: "disabled",
            });
          }
          const result = yield* fetchTools(integration).pipe(
            // A passing test is a fresh tool list, so the list view shows it.
            Effect.tap((tools) =>
              Effect.gen(function* () {
                const key = `${integration.id}:${integration.updatedAt}`;
                const at = yield* Clock.currentTimeMillis;
                yield* Ref.update(cache, (entries) =>
                  new Map(entries).set(key, { key, atMs: at, result: tools }),
                );
              }),
            ),
            Effect.map((tools): IntegrationTestResult => ({
              status: "connected",
              toolCount: tools.tools.length,
              message: `Connected; ${tools.tools.length} tool(s) available.`,
            })),
            Effect.catch((error: IntegrationError) =>
              Effect.succeed<IntegrationTestResult>({
                status: "disconnected",
                toolCount: 0,
                message: `Could not connect (${error.reason}).`,
              }),
            ),
          );
          return result;
        }).pipe(Effect.mapError(failure("test connection", "storage"))),
      listTools: (name, labelId) => listTools(name, labelId),
      callTool: (name, tool, args, labelId) =>
        Effect.gen(function* () {
          const integration = yield* getByName(name, labelId);
          const result = yield* rpc(integration, "tools/call", {
            name: tool,
            arguments: args ?? {},
          });
          const record =
            typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : undefined;
          return {
            content: result ?? null,
            ...(typeof record?.isError === "boolean" ? { isError: record.isError } : {}),
          } satisfies IntegrationCallResult;
        }),
      contextIntegrations: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) => integrationVisibleTo(integration, labelId)),
          ),
        ),
    });
  });

export const layerWith = (
  options: IntegrationsOptions,
): Layer.Layer<
  Integrations,
  never,
  SqlClient.SqlClient | Crypto.Crypto | HttpClient.HttpClient | Credentials.IntegrationCredentials
> => Layer.effect(Integrations, make(options));

export const layer: Layer.Layer<
  Integrations,
  never,
  SqlClient.SqlClient | Crypto.Crypto | HttpClient.HttpClient | Credentials.IntegrationCredentials
> = layerWith({});

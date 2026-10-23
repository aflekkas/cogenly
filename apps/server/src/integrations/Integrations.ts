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
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024;
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

const CREDENTIAL_REF = /\{\{credential:([^}]*)\}\}/g;

/** Credential references referenced by a header template, in order. */
export const credentialRefsIn = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(CREDENTIAL_REF)].map((match) => (match[1] ?? "").trim());

/** The vault item names a set of headers references, which an owner approves together. */
const credentialItemsIn = (headers: Readonly<Record<string, string>>): Array<string> => [
  ...new Set(
    Object.values(headers).flatMap((template) =>
      credentialRefsIn(template).flatMap((ref) => {
        const parsed = Credentials.parseCredentialRef(ref);
        return parsed === undefined ? [] : [parsed.item];
      }),
    ),
  ),
];

/**
 * What clients and agents see in place of a literal header value, which may be
 * a pasted secret. Credential templates are shown as they are. Sending the
 * mask back in an update keeps the stored value.
 */
export const HEADER_MASK = "••••";

/** Headers as clients and agents may see them. */
export const redactHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value === "" || credentialRefsIn(value).length > 0 ? value : HEADER_MASK,
    ]),
  );

const redactIntegration = (integration: Integration): Integration => ({
  ...integration,
  headers: redactHeaders(integration.headers),
});

/** Treat every header as sensitive: even a static Host header can change routing. */
export const integrationDestinationChanged = (
  current: Integration,
  input: IntegrationUpdateInput,
): boolean =>
  (input.url !== undefined && input.url !== current.url) ||
  (input.transport !== undefined && input.transport !== current.transport) ||
  (input.headers !== undefined &&
    (Object.keys(input.headers).length !== Object.keys(current.headers).length ||
      Object.entries(input.headers).some(
        ([name, value]) => value !== HEADER_MASK && current.headers[name] !== value,
      )));

/** Adding any project, or switching to all projects, needs owner approval. */
export const integrationScopeWidened = (
  current: Integration,
  input: IntegrationUpdateInput,
): boolean =>
  input.scope !== undefined &&
  current.scope.type !== "all" &&
  (input.scope.type === "all" ||
    input.scope.labelIds.some(
      (id) => current.scope.type === "projects" && !current.scope.labelIds.includes(id),
    ));

/**
 * Resolves `{{credential:item.field}}` references in every header value.
 * Fails closed: an unknown template, a malformed reference, or a missing
 * credential fails the whole resolution and no headers are produced.
 */
export const resolveHeaderTemplates = (
  headers: Readonly<Record<string, string>>,
  resolve: (
    ref: string,
  ) => Effect.Effect<
    Option.Option<string>,
    Credentials.IntegrationCredentialError | Credentials.IntegrationCredentialNotAllowedError
  >,
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
            (error) =>
              new IntegrationError({
                operation: "resolve credentials",
                reason:
                  error._tag === "IntegrationCredentialNotAllowedError"
                    ? "credential_not_allowed"
                    : "credential_unresolved",
              }),
          ),
        );
        if (Option.isNone(secret)) {
          return yield* new IntegrationError({
            operation: "resolve credentials",
            reason: "credential_unresolved",
          });
        }
        value = value.replaceAll(`{{credential:${ref}}}`, () => secret.value);
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

/**
 * How a write was authorized. The owner's own writes (Settings, or approving
 * an agent's proposal) approve the vault items in the headers for the
 * integration's origin; any other write approves nothing.
 */
export interface IntegrationWriteOptions {
  readonly approveCredentials?: boolean;
  readonly callerLabelId?: ProjectLabelId | null | undefined;
  readonly preserveScope?: boolean;
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
      options?: IntegrationWriteOptions,
    ) => Effect.Effect<{ integration: Integration }, IntegrationError>;
    /** A changed origin drops every credential approval unless this write approves anew. */
    readonly update: (
      input: IntegrationUpdateInput,
      options?: IntegrationWriteOptions & { readonly preserveCredentialDestination?: boolean },
    ) => Effect.Effect<{ integration: Integration }, IntegrationError>;
    /** Tombstones the integration; its name becomes reusable. */
    readonly remove: (
      id: IntegrationId,
      options?: IntegrationWriteOptions,
    ) => Effect.Effect<{ deleted: boolean }, IntegrationError>;
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

const RpcEnvelope = {
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
};
const JsonRpcResponse = Schema.Union([
  Schema.Struct({ ...RpcEnvelope, result: Schema.Unknown, error: Schema.optional(Schema.Never) }),
  Schema.Struct({
    ...RpcEnvelope,
    result: Schema.optional(Schema.Never),
    error: Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  }),
]);
type JsonRpcResponse = typeof JsonRpcResponse.Type;
const decodeRpcBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));

const parseRpcBody = (text: string): JsonRpcResponse | undefined => {
  const trimmed = text.trim();
  const candidates = [trimmed];
  let data: Array<string> = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length > 0) candidates.push(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length > 0) candidates.push(data.join("\n"));
  for (const candidate of candidates.toReversed()) {
    const parsed = decodeRpcBody(candidate);
    if (Option.isSome(parsed)) return parsed.value;
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
            const prefix = `${integration.id}:${integration.updatedAt}`;
            const cached =
              entries.get(prefix) ??
              [...entries.values()].find((entry) => entry.key.startsWith(`${prefix}:`));
            return {
              integration: redactIntegration(integration),
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
          // Fetch otherwise forwards custom secret headers across redirects.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(
            (cause) =>
              new IntegrationError({ operation: method, reason: "upstream_unreachable", cause }),
          ),
        );
        const decoder = new TextDecoder();
        let bytes = 0;
        const text = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => "",
            (text, chunk) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_UPSTREAM_BODY_BYTES) {
                return Effect.fail(
                  new IntegrationError({ operation: method, reason: "upstream_error" }),
                );
              }
              return Effect.succeed(text + decoder.decode(chunk, { stream: true }));
            },
          ),
          Effect.map((text) => text + decoder.decode()),
          Effect.mapError(failure(method, "upstream_error")),
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
      }).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new IntegrationError({
                operation: method,
                reason: "upstream_timeout",
              }),
            ),
        }),
      );

    /** One upstream round trip: resolve credentials, handshake, then call. */
    const rpc = (
      integration: Integration,
      method: string,
      params: unknown,
      labelId?: ProjectLabelId | null,
    ) =>
      Effect.gen(function* () {
        const endpoint = new URL(integration.url);
        if (
          integration.credentialOrigin !== undefined &&
          integration.credentialOrigin !== endpoint.origin &&
          Object.values(integration.headers).some((value) => credentialRefsIn(value).length > 0)
        ) {
          return yield* new IntegrationError({
            operation: method,
            reason: "credential_unresolved",
          });
        }
        const destination: Credentials.CredentialDestination = {
          host: endpoint.hostname,
          scopeProjectId: labelId,
          approvedItems:
            integration.credentialOrigin === endpoint.origin
              ? (integration.approvedCredentialItems ?? [])
              : [],
        };
        const headers = yield* resolveHeaderTemplates(integration.headers, (ref) =>
          credentials.resolve(ref, destination),
        );
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

    const fetchTools = (integration: Integration, labelId?: ProjectLabelId | null) =>
      rpc(integration, "tools/list", {}, labelId).pipe(
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
        const key = `${integration.id}:${integration.updatedAt}${labelId === undefined ? "" : labelId === null ? ":unfiled" : `:project:${labelId}`}`;
        if (!force) {
          const entries = yield* Ref.get(cache);
          const cached = entries.get(key);
          const at = yield* Clock.currentTimeMillis;
          if (cached !== undefined && at - cached.atMs < ttlMs) return cached.result;
        }
        const result = yield* fetchTools(integration, labelId);
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
      create: (input, options) =>
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
            credentialOrigin: new URL(input.url).origin,
            approvedCredentialItems: options?.approveCredentials
              ? credentialItemsIn(input.headers)
              : [],
            enabled: input.enabled ?? true,
            scope: input.scope,
            hint: input.hint,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          };
          yield* persist(integration);
          return { integration: redactIntegration(integration) };
        }).pipe(Effect.mapError(failure("create", "storage"))),
      update: (masked, options) =>
        Effect.gen(function* () {
          const current = yield* getById(masked.id);
          if (!integrationVisibleTo({ ...current, enabled: true }, options?.callerLabelId))
            return yield* new IntegrationError({ operation: "update", reason: "not_found" });
          if (options?.preserveScope && integrationScopeWidened(current, masked))
            return yield* new IntegrationError({
              operation: "update",
              reason: "approval_required",
            });
          // A masked value is one the caller left as it was.
          const input: IntegrationUpdateInput =
            masked.headers === undefined
              ? masked
              : {
                  ...masked,
                  headers: yield* Effect.forEach(Object.entries(masked.headers), ([name, value]) =>
                    value !== HEADER_MASK
                      ? Effect.succeed([name, value] as const)
                      : current.headers[name] !== undefined
                        ? Effect.succeed([name, current.headers[name]] as const)
                        : Effect.fail(
                            new IntegrationError({
                              operation: "update",
                              reason: "invalid_request",
                            }),
                          ),
                  ).pipe(Effect.map(Object.fromEntries<string>)),
                };
          if (
            options?.preserveCredentialDestination &&
            integrationDestinationChanged(current, input)
          ) {
            return yield* new IntegrationError({ operation: "update", reason: "invalid_request" });
          }
          if (input.url !== undefined) yield* validateUrl(input.url);
          const credentialOrigin = options?.preserveCredentialDestination
            ? (current.credentialOrigin ?? new URL(current.url).origin)
            : new URL(input.url ?? current.url).origin;
          const headers = input.headers ?? current.headers;
          const approvedCredentialItems = options?.approveCredentials
            ? credentialItemsIn(headers)
            : credentialOrigin === current.credentialOrigin
              ? (current.approvedCredentialItems ?? [])
              : [];
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
            credentialOrigin,
            approvedCredentialItems,
          };
          yield* persist(integration);
          yield* invalidate(integration.id);
          return { integration: redactIntegration(integration) };
        }).pipe(sql.withTransaction, Effect.mapError(failure("update", "storage"))),
      remove: (id, options) =>
        Effect.gen(function* () {
          const current = yield* getById(id).pipe(
            Effect.catchTags({
              IntegrationError: (error) =>
                error.reason === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
            }),
          );
          if (current === undefined) return { deleted: false };
          if (!integrationVisibleTo({ ...current, enabled: true }, options?.callerLabelId))
            return yield* new IntegrationError({ operation: "delete", reason: "not_found" });
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
          const result = yield* rpc(
            integration,
            "tools/call",
            {
              name: tool,
              arguments: args ?? {},
            },
            labelId,
          );
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

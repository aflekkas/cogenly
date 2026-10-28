import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
import { AccountsToolkit } from "./toolkits/accounts/tools.ts";
import * as AccountsHandlers from "./toolkits/accounts/handlers.ts";
import * as AccountsMcp from "./AccountsMcpService.ts";
import * as SearchMcp from "../search/Mcp.ts";
import { ProjectLabelsToolkit } from "./toolkits/projectLabels/tools.ts";
import * as ProjectLabelsHandlers from "./toolkits/projectLabels/handlers.ts";
import * as WorkMcp from "../work/WorkMcp.ts";
import * as AgentBuilderMcp from "../agents/BuilderMcp.ts";
import * as AgentsMcp from "../agents/AgentsMcp.ts";
import * as AgentWorkspaceMcp from "../agents/WorkspaceMcp.ts";
import * as AgentMcpPolicy from "../agents/AgentMcpPolicy.ts";
import * as AgentMemoryMcp from "../agents/MemoryMcp.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  ComputerUseUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationError,
} from "@cogenly/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as VisualState from "../htmlRender/VisualState.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as DesktopAppControl from "../environment/DesktopAppControl.ts";
import * as MachineSecurity from "../security/MachineSecurity.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { VaultToolkit } from "./toolkits/vault/tools.ts";
import * as VaultHandlers from "./toolkits/vault/handlers.ts";
import * as TerminalHandlers from "./toolkits/terminal/handlers.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import * as ComputerHandlers from "./toolkits/computer/handlers.ts";
import {
  ComputerScreenshotTool,
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
} from "./toolkits/computer/tools.ts";
import * as ComputerUseService from "../computerUse/ComputerUseService.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import {
  HtmlPreviewTool,
  HtmlPreviewToolkit,
  HtmlRenderToolkit,
  HtmlStateToolkit,
} from "./toolkits/html/tools.ts";
import * as ImageHandlers from "./toolkits/images/handlers.ts";
import { ImageToolkit } from "./toolkits/images/tools.ts";
import * as ProjectFilesHandlers from "./toolkits/projectFiles/handlers.ts";
import { ProjectHomeToolkit } from "./toolkits/projectHome/tools.ts";
import * as ProjectHomeHandlers from "./toolkits/projectHome/handlers.ts";
import { ProjectFilesToolkit } from "./toolkits/projectFiles/tools.ts";
import * as ImageSearchService from "../images/ImageSearchService.ts";
import { IntegrationsToolkit } from "./toolkits/integrations/tools.ts";
import { MachinesToolkit } from "./toolkits/machines/tools.ts";
import * as MachinesHandlers from "./toolkits/machines/handlers.ts";
import * as IntegrationsHandlers from "./toolkits/integrations/handlers.ts";

/** Where an MCP client discovers how to sign in (RFC 9728), at this request's own origin. */
const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/**
 * Agents Cogenly launched carry a registry token and must never be sent into
 * an OAuth flow when it dies: they cannot open a browser, and a sign-in
 * would mint a credential that outlives their session. Only a request that
 * does not look like a provider token is pointed at the OAuth metadata.
 */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid Cogenly MCP credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

/**
 * Resolves a bearer token that is not a provider-session token: an OAuth
 * client signed in from outside Cogenly. Undefined when the token is not one.
 */
export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("cogenly-server/mcp/McpHttpServer/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

// Unknown tools fail closed as writes. Toolkit registration supplies each read hint.
const agentToolReads = new Map<string, boolean>([
  ["preview_snapshot", true],
  ["device_screenshot", true],
  ["computer_screenshot", true],
  ["html_preview", true],
]);
const AgentToolRequest = Schema.Struct({
  id: Schema.Unknown,
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Unknown) }),
});

const isAgentToolRequest = Schema.is(AgentToolRequest);

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const agentPolicy = yield* AgentMcpPolicy.AgentMcpPolicy;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      // Without this the only symptom of a dead credential is the agent
      // quietly losing the whole `t3-code` toolkit for the rest of its
      // session, with nothing on the server to explain why.
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
      });
    }
    const toolRequest =
      request.method === "POST" ? yield* request.json.pipe(Effect.orElseSucceed(() => null)) : null;
    if (Array.isArray(toolRequest))
      return HttpServerResponse.jsonUnsafe({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Batch MCP requests are not supported." },
      });
    const call = isAgentToolRequest(toolRequest) ? toolRequest : null;
    if (call) {
      const readonly = agentToolReads.get(call.params.name) ?? false;
      const decision = yield* agentPolicy
        .beforeTool(invocation, call.params.name, call.params.arguments, readonly)
        .pipe(Effect.result);
      if (decision._tag === "Failure" || decision.success.handled) {
        const result =
          decision._tag === "Failure"
            ? {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: encodeJsonText({
                      code: decision.failure.code,
                      message: decision.failure.message,
                    }),
                  },
                ],
              }
            : {
                isError: false,
                structuredContent: decision.success.result,
                content: [{ type: "text", text: encodeJsonText(decision.success.result) }],
              };
        return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: call.id, result });
      }
    }
    return yield* httpEffect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        onToolSuccess: (name, result) =>
          agentPolicy
            .afterTool(invocation, name, agentToolReads.get(name) ?? false, result)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not persist agent tool activity", { toolName: name }),
              ),
            ),
        httpOrigin: HttpServerRequest.toURL(request).pipe(
          Option.map((url) => url.origin),
          Option.getOrUndefined,
        ),
      }),
      Effect.map(normalizeMcpHttpResponse),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full
 * accessibility tree and page text loses its locators too. Claude Code also
 * shows the model `structuredContent` in place of the text blocks when a
 * result has both, so both carry the same bounded snapshot. Keep it near
 * 20 KB and tell the agent what was cut. The short `omitted` notes may go a
 * little over; the provider limit is far above this.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Keeps server ARIA refs, drops legacy object trees, shortens page text, names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the bounded value, its
 * text, and notes on what is missing so the agent can reach for
 * preview_evaluate.
 */
const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  const ariaTree = typeof accessibilityTree === "string" ? accessibilityTree : undefined;
  if (accessibilityTree !== undefined && ariaTree === undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB, and the caps count characters, not bytes.
  // Halve one thing per round until the JSON fits: logs first, then page
  // text, then the locators. The identifier caps bound the rest, so this
  // terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  let ariaTreeChars = Math.min(ariaTree?.length ?? 0, 20_000);
  const value = () => ({
    ...bounded,
    ...(ariaTree === undefined ? {} : { accessibilityTree: cutText(ariaTree, ariaTreeChars) }),
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : ariaTreeChars > 0
            ? "accessibilityTree"
            : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else if (key === "accessibilityTree") {
      ariaTreeChars = Math.floor(ariaTreeChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      // slice(-0) keeps everything, so spell out the empty case.
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  if (ariaTree !== undefined && ariaTreeChars < ariaTree.length) {
    omitted.push(`accessibilityTree after ${ariaTreeChars} characters`);
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const crypto = yield* Crypto.Crypto;
  // Two saves in the same millisecond must not overwrite each other.
  const unique = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as Partial<SnapshotMetadata> & {
                readonly url?: string;
                readonly tab?: unknown;
                readonly screenshot?: {
                  readonly mimeType: "image/png" | "image/jpeg";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = screenshot
                ? new Uint8Array(Buffer.from(screenshot.data, "base64"))
                : undefined;
              const saved =
                payload?.save === true && png
                  ? yield* saveScreenshot(snapshot.url ?? "", png).pipe(
                      Effect.map((screenshotPath) => ({ screenshotPath })),
                      Effect.orElseSucceed(() => ({
                        screenshotError:
                          "Screenshot could not be saved; structured page data is still available.",
                      })),
                    )
                  : {};
              const includeImage = payload?.includeImage === true && screenshot !== undefined;
              if ("screenshotPath" in saved && !includeImage) {
                const value = {
                  url: snapshot.url,
                  ...saved,
                  ...(snapshot.tab === undefined ? {} : { tab: snapshot.tab }),
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: value,
                  content: [{ type: "text", text: encodeJsonText(value) }],
                });
              }
              const metadata = {
                ...page,
                ...saved,
                ...(screenshot
                  ? {
                      screenshot: {
                        mimeType: screenshot.mimeType,
                        width: screenshot.width,
                        height: screenshot.height,
                      },
                    }
                  : {}),
              };
              const bounded =
                typeof metadata.visibleText === "string"
                  ? boundSnapshotMetadata(metadata as SnapshotMetadata)
                  : { value: metadata, text: encodeJsonText(metadata), omitted: [] };
              const value =
                bounded.omitted.length === 0
                  ? bounded.value
                  : { ...bounded.value, omitted: bounded.omitted };
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent: value,
                content: [
                  { type: "text", text: encodeJsonText(value) },
                  ...(includeImage && screenshot && png
                    ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
                    : []),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag unless the tool describes them: the remote
 * message may carry renderer or device output the agent should not see, and
 * the tag is what it can act on. A describer returns a server-built message.
 */
const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const message =
      typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error);
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string | ((error: E) => string),
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: advertisedJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { screenshot, ...rest } = encodedResult as ImageToolResult;
                const includeImage =
                  (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                  false;
                const metadata = {
                  ...rest,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                  },
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(includeImage
                        ? [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]
                        : []),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "screenshot",
    "Device screenshot failed.",
  );
});

const isComputerUseUnavailableError = Schema.is(ComputerUseUnavailableError);

const registerComputerScreenshot = Effect.fn("McpHttpServer.registerComputerScreenshot")(
  function* () {
    const computer = yield* ComputerUseService.ComputerUse;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const built = yield* ComputerScreenshotToolkit;
    yield* registerImageTool(
      ComputerScreenshotTool,
      (payload) =>
        built
          .handle("computer_screenshot", payload)
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
      (effect) =>
        effect.pipe(
          Effect.provideService(ComputerUseService.ComputerUse, computer),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      "screenshot",
      // The service writes these messages for the agent, including which grant is missing.
      (error) => (isComputerUseUnavailableError(error) ? error.message : "Screenshot failed."),
    );
  },
);

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const registerHtmlPreview = Effect.fn("McpHttpServer.registerHtmlPreview")(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* HtmlPreviewToolkit;
  yield* registerImageTool(
    HtmlPreviewTool,
    (payload) =>
      built
        .handle("html_preview", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(HtmlRender.HtmlRender, htmlRender),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "preview",
    // Parameter errors and HTML render errors are both written by the server for the agent.
    (error) =>
      isOrchestratorMcpFailure(error) || AiError.isAiError(error)
        ? error.message
        : "HTML preview failed.",
  );
});

/**
 * Every result reaches the client as `CallToolResult.structuredContent`,
 * which must be a JSON value. A result with an absent optional field or a
 * `DateTime` would fail that check after the handler had already applied its
 * change, so each tool encodes its result through the schema's JSON codec.
 */
const withJsonResults = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  // Same tools, names and handlers; only the result codec changes.
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setSuccess(Schema.toCodecJson(tool.successSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

/** Substitute compact inputs at registration, leaving handlers and result codecs intact. */
const withAdvertisedSchemas = Effect.fn("McpHttpServer.withAdvertisedSchemas")(function* <
  Tools extends Record<string, Tool.Any>,
  A,
  E,
  R,
>(toolkit: Toolkit.Toolkit<Tools>, registration: Effect.Effect<A, E, R>) {
  const server = yield* McpServer.McpServer;
  const tools: Record<string, Tool.Any> = toolkit.tools;
  return yield* registration.pipe(
    Effect.provideService(
      McpServer.McpServer,
      McpServer.McpServer.of({
        ...server,
        addTool: (options) => {
          const tool = tools[options.tool.name];
          return server.addTool(
            tool === undefined
              ? options
              : {
                  ...options,
                  tool: new McpSchema.Tool({
                    ...options.tool,
                    inputSchema: advertisedJsonSchema(tool),
                  }),
                },
          );
        },
      }),
    ),
  );
});

/**
 * `McpServer.toolkit` for handlers that declared their access (see
 * `McpToolAccess`). Every toolkit on `/mcp` registers through this.
 *
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => {
  for (const tool of Object.values(toolkit.tools))
    agentToolReads.set(tool.name, Context.get(tool.annotations, Tool.Readonly));
  const registration = Layer.effectDiscard(
    withAdvertisedSchemas(toolkit, McpServer.registerToolkit(withJsonResults(toolkit))),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

/** A hand-registered tool, also only with handlers that declared their access. */
const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => Layer.effectDiscard(register).pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));

// The render service stores a page's first state through the visual state
// service, so it is built with it; both draw thread access from the server.
const layerHtmlRenderProvided = HtmlRender.layer.pipe(Layer.provide(VisualState.layer));

export const layerHtmlToolkit = Layer.mergeAll(
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  toolkitRegistration(HtmlStateToolkit, HtmlHandlers.layerState),
  imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
).pipe(
  // The state tools and the render service both draw on visual states; the
  // render service carries its own copy for its first-state write.
  Layer.provide(VisualState.layer),
  Layer.provide(layerHtmlRenderProvided),
);

const layerPreviewStandardToolkitRegistration = toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
);

const layerPreviewSnapshotRegistration = imageToolRegistration(
  registerPreviewSnapshot(),
  PreviewHandlers.layerSnapshot,
);

export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
);

export const layerOrchestratorToolkit = toolkitRegistration(
  OrchestratorToolkit,
  OrchestratorHandlers.layer,
).pipe(Layer.provide(OrchestratorMcpService.layer), Layer.provide(ThreadMetadataMcpService.layer));

export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer);

const layerWorktreeToolkitRegistration = toolkitRegistration(
  WorktreeToolkit,
  WorktreeHandlers.layer,
).pipe(Layer.provide(WorktreeMcpService.layer));

const layerPreviewControlsRegistration = toolkitRegistration(
  PreviewControlsToolkit,
  PreviewControlsHandlers.layer,
);

export const layerEnvironmentToolkit = toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(DesktopAppControl.layer),
  Layer.provide(MachineSecurity.layer),
);

const layerProjectLabelsRegistration = toolkitRegistration(
  ProjectLabelsToolkit,
  ProjectLabelsHandlers.layer,
);
const layerProjectRegistration = toolkitRegistration(ProjectToolkit, ProjectHandlers.layer);

export const layerAttachmentToolkit = toolkitRegistration(
  AttachmentToolkit,
  AttachmentHandlers.layer,
);

export const layerPullRequestsToolkit = toolkitRegistration(
  PullRequestsToolkit,
  PullRequestsHandlers.layer,
);

const layerDeviceStandardToolkitRegistration = toolkitRegistration(
  DeviceStandardToolkit,
  DeviceHandlers.layerStandard,
);

const layerDeviceScreenshotRegistration = imageToolRegistration(
  registerDeviceScreenshot(),
  DeviceHandlers.layerScreenshot,
);

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

export const layerComputerToolkit = Layer.mergeAll(
  toolkitRegistration(ComputerStandardToolkit, ComputerHandlers.layerStandard),
  imageToolRegistration(registerComputerScreenshot(), ComputerHandlers.layerScreenshot),
);

export const layerMcpTransport = McpServer.layerHttp({
  name: "Cogenly",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
}).pipe(Layer.provide(layerMcpAuthMiddleware));

export const layer = Layer.mergeAll(
  layerPreviewToolkit,
  toolkitRegistration(AgentMemoryMcp.toolkit, AgentMemoryMcp.handlers),
  toolkitRegistration(WorkMcp.toolkit, WorkMcp.handlers),
  toolkitRegistration(SearchMcp.toolkit, SearchMcp.handlers),
  toolkitRegistration(ImageToolkit, ImageHandlers.layer).pipe(
    Layer.provide(ImageSearchService.layer),
  ),
  toolkitRegistration(AgentWorkspaceMcp.toolkit, AgentWorkspaceMcp.handlers),
  toolkitRegistration(AgentBuilderMcp.toolkit, AgentBuilderMcp.handlers),
  toolkitRegistration(AgentsMcp.toolkit, AgentsMcp.handlers),
  layerOrchestratorToolkit,
  toolkitRegistration(TerminalToolkit, TerminalHandlers.layer).pipe(
    Layer.provide(TerminalMcpService.layer.pipe(Layer.provide(ReadOnlySandbox.layer))),
    Layer.provide(ThreadCommandExecutor.layer),
  ),
  layerThreadToolkit,
  toolkitRegistration(VaultToolkit, VaultHandlers.layer),
  toolkitRegistration(AccountsToolkit, AccountsHandlers.layer).pipe(
    Layer.provide(AccountsMcp.layer),
  ),
  layerAttachmentToolkit,
  layerProjectRegistration,
  layerProjectLabelsRegistration,
  // Integrations bubbles to the server root like ProjectFiles.
  toolkitRegistration(IntegrationsToolkit, IntegrationsHandlers.layer),
  // machine_pair runs through the desktop app, which is signed in to both machines.
  toolkitRegistration(MachinesToolkit, MachinesHandlers.layer).pipe(
    Layer.provide(DesktopAppControl.layer),
  ),
  // ProjectFiles bubbles to the server root like ThreadManagement.
  toolkitRegistration(ProjectFilesToolkit, ProjectFilesHandlers.layer),
  // ProjectHome bubbles to the server root like ProjectFiles.
  toolkitRegistration(ProjectHomeToolkit, ProjectHomeHandlers.layer),
  layerEnvironmentToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerComputerToolkit,
  layerHtmlToolkit,
).pipe(Layer.provideMerge(layerMcpTransport));

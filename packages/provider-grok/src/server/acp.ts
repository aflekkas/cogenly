// @effect-diagnostics globalTimers:off
// The connection owns process shutdown; native deadlines cover initialize before an Effect resource exists.
// @effect-diagnostics nodeBuiltinImport:off -- The ACP host is a Node child process at the adapter boundary.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

import { parseGrokAccount, parseGrokModelState, type GrokModelState } from "./protocol.ts";

/**
 * A minimal Agent Client Protocol client for `grok agent stdio`: JSON-RPC 2.0,
 * one message per line in each direction. Cogenly advertises no filesystem or
 * terminal client capabilities, so Grok uses its own tools and only asks the
 * client for permission (`session/request_permission`).
 */

export interface AcpNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface AcpServerRequest {
  readonly method: string;
  readonly params: unknown;
}

export interface AcpProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A JSON-RPC error the agent returned. */
export class AcpRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export interface GrokAcpConnection {
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly notify: (method: string, params: unknown) => void;
  readonly onNotification: (listener: (notification: AcpNotification) => void) => void;
  /** Answers agent-to-client requests; a throw becomes a JSON-RPC error reply. */
  readonly onRequest: (handler: (request: AcpServerRequest) => Promise<unknown>) => void;
  readonly onProtocolError: (listener: (cause: unknown) => void) => void;
  /** Settles when stdout ends. */
  readonly closed: Promise<void>;
}

export interface GrokAcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: {
    readonly loadSession: boolean;
    readonly image: boolean;
    readonly mcpHttp: boolean;
  };
  readonly authMethodIds: ReadonlyArray<string>;
  readonly agentVersion: string | null;
  /** `_meta.modelState`: the models and reasoning tiers this login can use. */
  readonly modelState: GrokModelState;
}

/** The signed-in account, from `authenticate`'s `_meta`. */
export interface GrokAccount {
  readonly email: string | undefined;
  readonly subscriptionTier: string | undefined;
}

export interface GrokAcpHost {
  readonly connection: GrokAcpConnection;
  readonly initializeResult: GrokAcpInitializeResult;
  readonly account: GrokAccount;
  readonly exited: Promise<AcpProcessExit>;
  /** The last lines Grok wrote to stderr, for explaining an unexpected exit. */
  readonly stderrTail: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface GrokAcpHostOptions {
  readonly binaryPath: string;
  /** Arguments before `agent stdio`, for a launcher in front of the binary. */
  readonly launchArgs?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  /** Test hook: spawns the agent process. */
  readonly spawn?: typeof NodeChildProcess.spawn;
}

const STDERR_TAIL_LINES = 20;

/** Drops inherited xAI API keys so the CLI uses its subscription login; an instance value still wins. */
export function makeGrokEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const dropped = new Set(["XAI_API_KEY", "GROK_API_KEY", "GROK_DEPLOYMENT_KEY"]);
  return Object.fromEntries(
    Object.keys(environment)
      .filter((key) => !dropped.has(key.toUpperCase()))
      .map((key) => [key, environment[key]]),
  );
}

/** The arguments that start Grok's ACP host. */
export function grokAgentArgs(): ReadonlyArray<string> {
  return ["agent", "stdio"];
}

/** What Cogenly sends in ACP `initialize`. */
export function grokInitializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "cogenly", title: "Cogenly", version: "1" },
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Reads the parts of `initialize`'s result Cogenly relies on; unknown fields are ignored. */
export function parseGrokInitializeResult(value: unknown): GrokAcpInitializeResult {
  const result = asRecord(value) ?? {};
  const capabilities = asRecord(result.agentCapabilities) ?? {};
  const prompt = asRecord(capabilities.promptCapabilities) ?? {};
  const mcp = asRecord(capabilities.mcpCapabilities) ?? {};
  const info = asRecord(result.agentInfo) ?? {};
  const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
  return {
    protocolVersion: typeof result.protocolVersion === "number" ? result.protocolVersion : 1,
    agentCapabilities: {
      loadSession: capabilities.loadSession === true,
      image: prompt.image === true,
      mcpHttp: mcp.http === true,
    },
    authMethodIds: authMethods.flatMap((method) => {
      const id = asRecord(method)?.id;
      return typeof id === "string" ? [id] : [];
    }),
    agentVersion: typeof info.version === "string" ? info.version : null,
    modelState: parseGrokModelState(asRecord(result._meta)?.modelState),
  };
}

/** The subscription login method, when Grok offers it; API keys stay out of Cogenly. */
export const GROK_SUBSCRIPTION_AUTH_METHOD = "cached_token";

/** One Grok ACP process. The handle owns cleanup even when initialize never replies. */
export async function createGrokAcpHost(options: GrokAcpHostOptions): Promise<GrokAcpHost> {
  options.signal?.throwIfAborted();
  const spawn = options.spawn ?? NodeChildProcess.spawn;
  const child = spawn(options.binaryPath, [...(options.launchArgs ?? []), ...grokAgentArgs()], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.environment ?? makeGrokEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrTail: Array<string> = [];
  let stderrBuffer = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  const exited = new Promise<AcpProcessExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  let nextId = 1;
  const pending = new Map<
    number,
    {
      readonly method: string;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  const notificationListeners: Array<(notification: AcpNotification) => void> = [];
  const protocolErrorListeners: Array<(cause: unknown) => void> = [];
  let requestHandler: ((request: AcpServerRequest) => Promise<unknown>) | undefined;

  const write = (message: Record<string, unknown>) => {
    if (!child.stdin || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const reportProtocolError = (cause: unknown) => {
    for (const listener of protocolErrorListeners) listener(cause);
  };

  const handleMessage = (message: Record<string, unknown>) => {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method !== undefined && id !== undefined && id !== null) {
      // An agent-to-client request.
      const respond = (result: unknown) => write({ id, result: result ?? null });
      const fail = (error: unknown) =>
        write({
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Request failed",
          },
        });
      if (!requestHandler) {
        write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
      }
      void requestHandler({ method, params: message.params }).then(respond, fail);
      return;
    }
    if (method !== undefined) {
      for (const listener of notificationListeners) listener({ method, params: message.params });
      return;
    }
    if (typeof id === "number") {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      const error = asRecord(message.error);
      if (error) {
        entry.reject(
          new AcpRpcError(
            entry.method,
            typeof error.code === "number" ? error.code : -32603,
            typeof error.message === "string" && error.message
              ? error.message
              : `Grok ${entry.method} failed`,
            error.data,
          ),
        );
      } else entry.resolve(message.result);
    }
  };

  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        // Agents can print diagnostics on stdout; only JSON-RPC frames matter.
        if (line.startsWith("{")) reportProtocolError(cause);
        continue;
      }
      const message = asRecord(parsed);
      if (message) handleMessage(message);
    }
  });
  const closed = new Promise<void>((resolve) => {
    child.stdout?.once("close", () => resolve());
    child.once("exit", () => resolve());
  });
  void closed.then(() => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(`Grok closed before answering ${entry.method}.`));
    }
  });

  const connection: GrokAcpConnection = {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.stdin?.destroyed) {
          reject(new Error(`Grok is not running; cannot send ${method}.`));
          return;
        }
        const id = nextId++;
        pending.set(id, { method, resolve, reject });
        write({ id, method, params });
      }),
    notify: (method, params) => write({ method, params }),
    onNotification: (listener) => {
      notificationListeners.push(listener);
    },
    onRequest: (handler) => {
      requestHandler = handler;
    },
    onProtocolError: (listener) => {
      protocolErrorListeners.push(listener);
    },
    closed,
  };

  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.end();
      const terminate = setTimeout(() => child.kill("SIGTERM"), 2_000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 7_000);
      terminate.unref();
      kill.unref();
      await exited;
      clearTimeout(terminate);
      clearTimeout(kill);
    })());

  let rejectStartup: (reason: unknown) => void = () => {};
  const onAbort = () => {
    rejectStartup(options.signal?.reason ?? new Error("Grok startup aborted."));
    void close().catch(() => {});
  };
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  void exited.then((exit) => {
    const reason = stderrTail.findLast((line) => line.trim())?.trim();
    rejectStartup(
      new Error(
        `Grok exited during startup (${exit.code ?? exit.signal ?? "spawn failed"})${reason ? `: ${reason}` : ""}`,
      ),
    );
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => rejectStartup(new Error("Grok ACP initialization timed out.")),
    options.startupTimeoutMs ?? 20_000,
  );
  timer.unref();
  try {
    const initializeResult = parseGrokInitializeResult(
      await Promise.race([connection.request("initialize", grokInitializeParams()), interrupted]),
    );
    let account: GrokAccount = { email: undefined, subscriptionTier: undefined };
    if (initializeResult.authMethodIds.includes(GROK_SUBSCRIPTION_AUTH_METHOD)) {
      account = parseGrokAccount(
        await Promise.race([
          connection
            .request("authenticate", { methodId: GROK_SUBSCRIPTION_AUTH_METHOD })
            .catch((cause: unknown) => {
              throw new Error(
                `Grok is not signed in (${cause instanceof Error ? cause.message : "authenticate failed"}). Run \`grok login\` on this Cogenly server host.`,
              );
            }),
          interrupted,
        ]),
      );
    }
    // Never resolves; later rejections (exit after startup) are the adapter's to report.
    void interrupted.catch(() => {});
    return {
      connection,
      initializeResult,
      account,
      exited,
      stderrTail: () => [...stderrTail],
      close,
    };
  } catch (error) {
    void interrupted.catch(() => {});
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Cancellation waits for native shutdown before callers release startup resources. */
export const createGrokAcpHostEffect = Effect.fn("createGrokAcpHostEffect")(function* (
  options: Omit<GrokAcpHostOptions, "signal">,
  createHost: typeof createGrokAcpHost = createGrokAcpHost,
) {
  let startup: Promise<GrokAcpHost> | undefined;
  return yield* Effect.tryPromise((signal) => {
    startup = createHost({ ...options, signal });
    return startup;
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await startup?.then(
          (host) => host.close(),
          () => {},
        );
      }),
    ),
  );
});

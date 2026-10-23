import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// Node's ephemeral listener selects a loopback port without a platform-specific shell command.
import * as NodeNet from "node:net";
import { redactUpstream, upstreamErrorMessage } from "../UpstreamResult.ts";
import { isGrantRejection } from "./GrantRejection.ts";
import { createOutputRedactor } from "./OutputRedactor.ts";

export class LocalMcpError extends Schema.TaggedError<LocalMcpError>()("LocalMcpError", {
  reason: Schema.Literals([
    "missing_runtime",
    "start_failed",
    "not_running",
    "protocol",
    "sign_in_required",
    "timeout",
  ]),
  runtime: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.reason === "missing_runtime") {
      return this.runtime === "uvx"
        ? "uvx is missing. Install uv with brew install uv (macOS) or curl -LsSf https://astral.sh/uv/install.sh | sh (Linux), then try connecting again."
        : "npx is missing. Install Node.js LTS (https://nodejs.org), then try connecting again.";
    }
    return `Managed MCP server ${this.reason.replaceAll("_", " ")}.`;
  }
}

export interface LocalMcpSpec {
  readonly id: string;
  readonly runtime: string;
  readonly args: ReadonlyArray<string>;
  readonly version: string;
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: ReadonlyArray<string>;
  readonly transport: "http" | "stdio";
  readonly port: number;
  /** Environment fields rebuilt whenever a bind failure retires the port. */
  readonly portEnvironment?: Readonly<Record<string, string>>;
  readonly path?: string;
}

export interface LocalMcpStatus {
  readonly state: "starting" | "running" | "failed" | "missing_runtime" | "stopped";
  readonly version: string;
  readonly stderrTail: string;
  readonly message?: string;
  readonly grantRejected?: boolean;
}

interface Connection {
  readonly rpc: (method: string, params: unknown) => Effect.Effect<unknown, LocalMcpError>;
}

interface Account {
  spec: LocalMcpSpec;
  readonly scope: Scope.Closeable;
  ready: Deferred.Deferred<Connection, LocalMcpError>;
  status: LocalMcpStatus;
  supervising: boolean;
}

export class LocalMcpRunner extends Context.Service<
  LocalMcpRunner,
  {
    readonly start: (spec: LocalMcpSpec) => Effect.Effect<void, LocalMcpError>;
    readonly rpc: (
      id: string,
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, LocalMcpError>;
    readonly stop: (id: string) => Effect.Effect<void>;
    readonly status: (id: string) => Effect.Effect<LocalMcpStatus | undefined>;
    readonly changes: Stream.Stream<{ readonly id: string; readonly status: LocalMcpStatus }>;
    readonly callback: (id: string, query: string) => Effect.Effect<boolean, LocalMcpError>;
  }
>()("cogenly-server/integrations/local/LocalMcpRunner") {}

/** Only the runner allocates loopback endpoints; integration definitions never choose one. */
export const freeLoopbackPort = Effect.callback<number, LocalMcpError>((resume) => {
  const server = NodeNet.createServer();
  server.once("error", (cause) =>
    resume(Effect.fail(new LocalMcpError({ reason: "start_failed", runtime: "", cause }))),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      server.close(() => resume(Effect.succeed(address.port)));
    }
  });
  return Effect.sync(() => {
    if (server.listening) server.close();
  });
});

const isLocalMcpError = Schema.is(LocalMcpError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(RpcResponse));

const ProcessOwner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  identity: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int,
});
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessOwner));

// stdin is an OS liveness pipe. The watchdog survives SIGKILL of Cogenly and
// signals only the recorded process group after verifying its start identity.
const parentWatchScript = `
  IFS= read -r ignored
  current=$(LC_ALL=C TZ=UTC ps -p "$1" -o lstart= -o comm=)
  [ "$current" = "$2" ] && kill -KILL -"$1"
  exit 0
`;

const make = (
  options: { readonly restartDelayMs?: number; readonly requestTimeoutMs?: number } = {},
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const lock = yield* Semaphore.make(1);
    const accounts = new Map<string, Account>();
    const updates = yield* PubSub.unbounded<{
      readonly id: string;
      readonly status: LocalMcpStatus;
    }>();
    let nextId = 0;
    const error = (spec: LocalMcpSpec, reason: LocalMcpError["reason"], cause?: unknown) =>
      new LocalMcpError({ reason, runtime: spec.runtime, cause });
    const rpcFailure = (spec: LocalMcpSpec, raw: unknown) => {
      const encoded = encodeJson({ error: raw });
      const message = upstreamErrorMessage(encoded);
      return error(
        spec,
        isGrantRejection(encoded) ? "sign_in_required" : "protocol",
        message === undefined
          ? undefined
          : redactUpstream(message, spec.secrets).replace(/\s+/g, " ").slice(0, 500),
      );
    };
    const changed = (account: Account, status: LocalMcpStatus["state"], message?: string) =>
      Effect.gen(function* () {
        account.status = {
          ...account.status,
          state: status,
          ...(message === undefined ? {} : { message }),
        };
        yield* PubSub.publish(updates, { id: account.spec.id, status: account.status });
      });
    const ownerFile = (spec: LocalMcpSpec) => path.join(spec.directory, "process.json");
    const identityOf = (pid: number) =>
      spawner
        .string(
          ChildProcess.make(
            platform === "win32" ? "powershell.exe" : "ps",
            platform === "win32"
              ? [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
                ]
              : ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
            { env: { LC_ALL: "C", TZ: "UTC" }, extendEnv: true },
          ),
        )
        .pipe(
          Effect.map((text) => text.trim()),
          Effect.timeout("2 seconds"),
        );
    const reconcile = (spec: LocalMcpSpec) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(ownerFile(spec)))) return;
        const previous = yield* fs
          .readFileString(ownerFile(spec))
          .pipe(Effect.flatMap(decodeOwner), Effect.option);
        if (previous._tag === "Some") {
          const owner = previous.value;
          const identity = yield* identityOf(owner.pid).pipe(Effect.option);
          if (identity._tag === "Some" && identity.value === owner.identity) {
            if (platform === "win32")
              yield* spawner.exitCode(
                ChildProcess.make("taskkill", ["/PID", String(owner.pid), "/T", "/F"]),
              );
            else yield* Effect.try(() => process.kill(-owner.pid, "SIGKILL"));
          }
        }
        yield* fs.remove(ownerFile(spec), { force: true });
      });
    const watchParent = (pid: number, identity: string) =>
      spawner.spawn(
        ChildProcess.make(
          platform === "win32" ? "powershell.exe" : "/bin/sh",
          platform === "win32"
            ? [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$null = [Console]::In.ReadToEnd(); $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq '${identity}') { taskkill /PID ${pid} /T /F }`,
              ]
            : ["-c", parentWatchScript, "cogenly-mcp-parent", String(pid), identity],
          { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
        ),
      );
    const stop = (id: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const account = accounts.get(id);
          if (!account) return;
          accounts.delete(id);
          yield* Deferred.fail(account.ready, error(account.spec, "not_running"));
          yield* Scope.close(account.scope, Exit.void);
          yield* fs.remove(ownerFile(account.spec), { force: true }).pipe(Effect.ignore);
          yield* changed(account, "stopped");
        }),
      );
    yield* Effect.addFinalizer(() => Effect.forEach([...accounts.keys()], stop, { discard: true }));

    const httpPost = (spec: LocalMcpSpec, method: string, params: unknown, sessionId?: string) =>
      Effect.gen(function* () {
        const id = ++nextId;
        const response = yield* client.execute(
          HttpClientRequest.post(`http://127.0.0.1:${spec.port}${spec.path ?? "/mcp"}`).pipe(
            HttpClientRequest.setHeaders({
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-03-26",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            }),
            HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, method, params }),
          ),
        );

        let bytes = 0;
        const chunks = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => [] as Array<Uint8Array>,
            (chunks, chunk) => {
              bytes += chunk.length;
              return bytes > 4 * 1024 * 1024
                ? Effect.fail(error(spec, "protocol"))
                : Effect.succeed([...chunks, chunk]);
            },
          ),
        );
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        if (response.status !== 200)
          return yield* rpcFailure(spec, {
            message: upstreamErrorMessage(text) ?? "Managed server refused the request.",
          });
        const candidates = [
          text,
          ...text.split(/\r?\n\r?\n/).map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n"),
          ),
        ];
        for (const candidate of candidates) {
          const parsed = decodeResponse(candidate);
          if (parsed._tag === "Some" && parsed.value.id === id) {
            if (parsed.value.error !== undefined)
              return yield* rpcFailure(spec, parsed.value.error);
            return {
              result: redactUpstream(parsed.value.result, spec.secrets),
              sessionId: response.headers["mcp-session-id"] ?? sessionId,
            };
          }
        }
        return yield* error(spec, "protocol");
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout(options.requestTimeoutMs ?? 30_000),
        Effect.mapError((cause) =>
          isLocalMcpError(cause) ? cause : error(spec, "protocol", cause),
        ),
      );

    const supervise = (account: Account) =>
      Effect.gen(function* () {
        let attempt = 0;
        while (accounts.get(account.spec.id) === account) {
          const spec = account.spec;
          let bindFailure = false;
          let attemptOutput = "";
          yield* changed(account, "starting");
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner
                .spawn(
                  ChildProcess.make(spec.runtime, [...spec.args], {
                    cwd: spec.directory,
                    env: spec.env,
                    extendEnv: false,
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                  }),
                )
                .pipe(Effect.mapError((cause) => error(spec, "start_failed", cause)));
              const identity = yield* identityOf(child.pid).pipe(
                Effect.mapError((cause) => error(spec, "start_failed", cause)),
              );
              if (!identity) return yield* error(spec, "start_failed");
              yield* fs
                .writeFileString(
                  ownerFile(spec),
                  encodeJson({ pid: child.pid, identity, port: spec.port }),
                  { mode: 0o600 },
                )
                .pipe(Effect.mapError((cause) => error(spec, "start_failed", cause)));
              yield* watchParent(child.pid, identity).pipe(
                Effect.mapError((cause) => error(spec, "start_failed", cause)),
              );
              const output = (stream: typeof child.stderr) => {
                const redactor = createOutputRedactor(spec.secrets);
                const retain = (text: string) =>
                  Effect.gen(function* () {
                    attemptOutput = (attemptOutput + text).slice(-4000);
                    bindFailure ||=
                      /EADDRINUSE|address already in use|error while attempting to bind|could not bind/i.test(
                        attemptOutput,
                      );
                    const stderrTail = (account.status.stderrTail + text).slice(-4000);
                    const rejected = !account.status.grantRejected && isGrantRejection(stderrTail);
                    account.status = {
                      ...account.status,
                      stderrTail,
                      ...(rejected ? { grantRejected: true } : {}),
                    };
                    if (rejected)
                      yield* PubSub.publish(updates, { id: spec.id, status: account.status });
                  });
                return stream.pipe(
                  Stream.decodeText(),
                  Stream.runForEach((chunk) => retain(redactor.push(chunk))),
                  Effect.ignore,
                  Effect.ensuring(Effect.suspend(() => retain(redactor.flush()))),
                );
              };
              yield* Effect.forkScoped(output(child.stderr));
              let connection: Connection;
              if (spec.transport === "stdio") {
                const outgoing = yield* Queue.unbounded<Uint8Array>();
                const pending = new Map<number, Deferred.Deferred<unknown, LocalMcpError>>();
                yield* Effect.addFinalizer(() =>
                  Effect.forEach(
                    [...pending.values()],
                    (deferred) => Deferred.fail(deferred, error(spec, "not_running")),
                    { discard: true },
                  ),
                );
                yield* Effect.forkScoped(
                  Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.ignore),
                );
                yield* Effect.forkScoped(
                  child.stdout.pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((line) =>
                      Effect.gen(function* () {
                        const parsed = decodeResponse(line);
                        if (parsed._tag !== "Some" || typeof parsed.value.id !== "number") return;
                        const deferred = pending.get(parsed.value.id);
                        if (!deferred) return;
                        yield* parsed.value.error === undefined
                          ? Deferred.succeed(
                              deferred,
                              redactUpstream(parsed.value.result, spec.secrets),
                            )
                          : Deferred.fail(deferred, rpcFailure(spec, parsed.value.error));
                      }),
                    ),
                    Effect.ignore,
                  ),
                );
                const rpc = (method: string, params: unknown) =>
                  Effect.gen(function* () {
                    const id = ++nextId;
                    const deferred = yield* Deferred.make<unknown, LocalMcpError>();
                    pending.set(id, deferred);
                    yield* Queue.offer(
                      outgoing,
                      new TextEncoder().encode(
                        encodeJson({ jsonrpc: "2.0", id, method, params }) + "\n",
                      ),
                    );
                    return yield* Deferred.await(deferred).pipe(
                      Effect.timeout(options.requestTimeoutMs ?? 30_000),
                      Effect.mapError((cause) =>
                        isLocalMcpError(cause) ? cause : error(spec, "timeout"),
                      ),
                      Effect.ensuring(
                        Effect.sync(() => {
                          pending.delete(id);
                        }),
                      ),
                    );
                  });
                yield* rpc("initialize", {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  clientInfo: { name: "cogenly", version: "1" },
                });
                yield* Queue.offer(
                  outgoing,
                  new TextEncoder().encode(
                    '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
                  ),
                );
                connection = { rpc };
              } else {
                yield* Effect.forkScoped(output(child.stdout));
                let initialized: { result: unknown; sessionId: string | undefined } | undefined;
                // The package manager may install the pinned release before the listener exists.
                for (let probe = 0; probe < 1200; probe++) {
                  const response = yield* httpPost(spec, "initialize", {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "cogenly", version: "1" },
                  }).pipe(Effect.option);
                  if (response._tag === "Some") {
                    initialized = response.value;
                    break;
                  }
                  if (bindFailure || !(yield* child.isRunning))
                    return yield* error(spec, "start_failed");
                  yield* Effect.sleep("100 millis");
                }
                if (!initialized) return yield* error(spec, "timeout");
                const sessionId = initialized.sessionId;
                // Streamable HTTP requires the initialized notification before tool requests.
                yield* client
                  .execute(
                    HttpClientRequest.post(
                      `http://127.0.0.1:${spec.port}${spec.path ?? "/mcp"}`,
                    ).pipe(
                      HttpClientRequest.setHeaders({
                        "content-type": "application/json",
                        accept: "application/json, text/event-stream",
                        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
                      }),
                      HttpClientRequest.bodyJsonUnsafe({
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                      }),
                    ),
                  )
                  .pipe(
                    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                    Effect.mapError((cause) => error(spec, "protocol", cause)),
                  );
                connection = {
                  rpc: (method, params) =>
                    httpPost(spec, method, params, sessionId).pipe(
                      Effect.map((response) => response.result),
                    ),
                };
              }
              yield* changed(account, "running");
              yield* Deferred.succeed(account.ready, connection);
              yield* child.exitCode;
            }),
          ).pipe(Effect.result);
          if (bindFailure) {
            const port = yield* freeLoopbackPort;
            account.spec = {
              ...spec,
              port,
              env: {
                ...spec.env,
                ...Object.fromEntries(
                  Object.entries(spec.portEnvironment ?? {}).map(([key, template]) => [
                    key,
                    template.replaceAll("{port}", String(port)),
                  ]),
                ),
              },
            };
          }
          yield* changed(account, "failed");
          yield* Deferred.fail(account.ready, error(spec, "start_failed", result));
          account.ready = yield* Deferred.make<Connection, LocalMcpError>();
          yield* Effect.sleep(
            Math.min((options.restartDelayMs ?? 1000) * 2 ** Math.min(attempt++, 6), 60_000),
          );
        }
      });

    return LocalMcpRunner.of({
      start: (spec) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const existing = accounts.get(spec.id);
            if (existing?.supervising) return;
            const runtimeExists = yield* Effect.forEach(
              (spec.env.PATH ?? "").split(path.sep === "\\" ? ";" : ":"),
              (directory) =>
                fs.exists(
                  path.isAbsolute(spec.runtime) ? spec.runtime : path.join(directory, spec.runtime),
                ),
            ).pipe(Effect.map((found) => found.some(Boolean)));
            if (existing && !runtimeExists && existing.status.state === "missing_runtime")
              return yield* error(spec, "missing_runtime");
            if (existing) {
              accounts.delete(spec.id);
              yield* Scope.close(existing.scope, Exit.void);
            }
            const scope = yield* Scope.make();
            const account: Account = {
              spec,
              scope,
              supervising: false,
              ready: yield* Deferred.make<Connection, LocalMcpError>(),
              status: { state: "starting", version: spec.version, stderrTail: "" },
            };
            accounts.set(spec.id, account);
            if (!runtimeExists) {
              const missing = error(spec, "missing_runtime");
              yield* changed(account, "missing_runtime", missing.message);
              yield* Deferred.fail(account.ready, missing);
              return yield* missing;
            }
            yield* fs.makeDirectory(spec.directory, { recursive: true, mode: 0o700 });
            yield* fs.chmod(spec.directory, 0o700);
            yield* reconcile(spec);
            account.supervising = true;
            yield* Effect.forkIn(
              supervise(account).pipe(
                Effect.ignore,
                Effect.ensuring(
                  Effect.sync(() => {
                    account.supervising = false;
                  }),
                ),
              ),
              scope,
            );
          }).pipe(
            Effect.mapError((cause) =>
              isLocalMcpError(cause) ? cause : error(spec, "start_failed", cause),
            ),
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                const account = accounts.get(spec.id);
                if (!account) return;
                if (
                  account.status.message === cause.message &&
                  (account.status.state === "missing_runtime" || account.status.state === "failed")
                )
                  return;
                yield* changed(
                  account,
                  cause.reason === "missing_runtime" ? "missing_runtime" : "failed",
                  cause.message,
                );
                yield* Deferred.fail(account.ready, cause);
              }),
            ),
          ),
        ),
      rpc: (id, method, params) =>
        Effect.gen(function* () {
          const account = accounts.get(id);
          if (!account) return yield* new LocalMcpError({ reason: "not_running", runtime: "" });
          return yield* Deferred.await(account.ready).pipe(
            Effect.flatMap((connection) => connection.rpc(method, params)),
          );
        }),
      stop,
      status: (id) => Effect.sync(() => accounts.get(id)?.status),
      changes: Stream.fromPubSub(updates),
      callback: (id, query) =>
        Effect.gen(function* () {
          const account = accounts.get(id);
          if (!account || account.status.state !== "running") return false;
          const response = yield* client
            .execute(
              HttpClientRequest.get(
                `http://127.0.0.1:${account.spec.port}/oauth2callback?${query}`,
              ),
            )
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              Effect.mapError((cause) => error(account.spec, "protocol", cause)),
            );
          yield* response.text.pipe(Effect.ignore);
          return response.status === 200;
        }).pipe(
          Effect.timeout(options.requestTimeoutMs ?? 30_000),
          Effect.mapError((cause) =>
            isLocalMcpError(cause) ? cause : new LocalMcpError({ reason: "timeout", runtime: "" }),
          ),
          Effect.withTracerEnabled(false),
        ),
    });
  });

export const layerWith = (options: {
  readonly restartDelayMs?: number;
  readonly requestTimeoutMs?: number;
}) => Layer.effect(LocalMcpRunner, make(options));
export const layer = layerWith({});

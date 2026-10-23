// @effect-diagnostics nodeBuiltinImport:off - Effect has no SOCKS proxy.
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

import { pinnedLookup, publicAddresses } from "../security/PublicAddress.ts";

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// What a client may send before its tunnel opens; a TLS hello fits easily.
const MAX_EARLY_BYTES = 64 * 1024;

/**
 * Answers and closes. The client is never read from again, so anything it
 * sent after its request is dropped rather than left buffered.
 */
const refuse = (client: NodeNet.Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

/** The CONNECT target in a complete SOCKS5 request, or "short" when more bytes are needed. */
const readRequest = (data: Buffer) => {
  if (data.length < 5) return "short" as const;
  // Version 5, reserved byte 0.
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
};

/**
 * Starts a SOCKS5 proxy on loopback for the life of the scope and returns its
 * port. The preview browser sends every connection through it, and it only
 * connects to public addresses. Chrome's Local Network Access misses some
 * requests, such as speculation-rules prefetches; nothing misses this. It
 * carries bytes only, so HTTP, TLS, and WebSockets pass through unchanged.
 */
export const publicProxy = Effect.acquireRelease(
  Effect.callback<
    { readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> },
    Error
  >((resume) => {
    const sockets = new Set<NodeNet.Socket>();
    const track = (socket: NodeNet.Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      return socket;
    };
    const server = NodeNet.createServer((client) => {
      track(client);
      let data = Buffer.alloc(0);
      let greeted = false;
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (!greeted) {
          if (data.length < 2 || data.length < 2 + data[1]!) return;
          // Version 5, offering "no authentication".
          if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
            return void client.end(Buffer.from([5, 0xff]));
          }
          data = data.subarray(2 + data[1]!);
          greeted = true;
          client.write(Buffer.from([5, 0]));
        }
        const request = readRequest(data);
        if (request === "short") return;
        client.off("data", onData);
        if (request === undefined || request.command !== 1 || request.port === 0) {
          return refuse(client, 7);
        }
        // Keeps reading while the target resolves, so a client that leaves is
        // noticed, and holds what it sends early up to a small cap.
        const early: Array<Buffer> = [request.rest];
        let earlyBytes = request.rest.length;
        const holdEarly = (chunk: Buffer) => {
          earlyBytes += chunk.length;
          if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
          early.push(chunk);
        };
        client.on("data", holdEarly);
        void publicAddresses(request.host).then((addresses) => {
          if (client.destroyed) return;
          client.off("data", holdEarly);
          if (addresses === undefined) return refuse(client, 2);
          client.pause();
          // Tries every checked address, IPv6 and IPv4 alike, so a host is
          // still reached on a network whose IPv6 route is broken. A name goes
          // through `lookup`, which hands back only the checked addresses; an
          // address literal connects as itself.
          const upstream = track(
            NodeNet.connect({
              host: request.host,
              port: request.port,
              autoSelectFamily: true,
              lookup: pinnedLookup(addresses),
            }),
          );
          upstream.once("connect", () => {
            client.write(reply(0));
            for (const chunk of early) upstream.write(chunk);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("close", () => client.destroy());
          client.on("close", () => upstream.destroy());
        });
      };
      client.on("data", onData);
    });
    // A failure to listen fails this preview; once listening, a server error
    // must not reach Node as an unhandled event either.
    let listening = false;
    server.on("error", (error) => {
      if (!listening) resume(Effect.fail(error));
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      resume(Effect.succeed({ server, sockets }));
    });
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map(({ server }) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

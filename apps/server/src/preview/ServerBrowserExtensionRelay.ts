// @effect-diagnostics nodeBuiltinImport:off - Bridges Chrome's pipe to a loopback Playwright CDP connection.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import { WebSocketServer } from "ws";
import type { CDPSession, Page } from "playwright-core";

// Playwright needs its files on disk, including in the bundled server.
const requirePlaywright = NodeModule.createRequire(import.meta.url);

interface Message {
  id?: number | undefined;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string | undefined;
  result?: Record<string, unknown>;
  error?: { message: string };
}
export interface ExtensionTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/** Nested CDP sessions over Playwright's existing Chrome pipe, including OOPIF sessions. */
export class ExtensionPipe extends NodeEvents.EventEmitter {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (cause: Error) => void }
  >();
  private readonly roots = new Map<string, string>();
  private readonly received = (event: { sessionId: string; message: string }) => {
    const message = JSON.parse(event.message) as Message;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result ?? {});
      return;
    }
    const child = message.params?.sessionId;
    if (message.method === "Target.attachedToTarget" && typeof child === "string")
      this.roots.set(child, event.sessionId);
    this.emit("event", message.method, message.params, message.sessionId ?? event.sessionId);
  };
  readonly cdp: CDPSession;
  constructor(cdp: CDPSession) {
    super();
    this.cdp = cdp;
    cdp.on("Target.receivedMessageFromTarget", this.received);
  }
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (!sessionId)
      return this.cdp.send(
        method as Parameters<CDPSession["send"]>[0],
        method === "Target.attachToTarget" ? { ...params, flatten: false } : params,
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const root = this.roots.get(sessionId);
      void this.cdp
        .send("Target.sendMessageToTarget", {
          sessionId: root ?? sessionId,
          message: JSON.stringify({ id, method, params, ...(root ? { sessionId } : {}) }),
        })
        .catch((cause: Error) => {
          this.pending.delete(id);
          reject(cause);
        });
    });
  }
  async close() {
    this.cdp.off("Target.receivedMessageFromTarget", this.received);
    for (const pending of this.pending.values())
      pending.reject(new Error("Extension target connection closed."));
    this.pending.clear();
    await this.cdp.detach().catch(() => {});
  }
}

/** Discover the owning tab through target ancestry, even when several pages have identical URLs. */
export async function hostTabTarget(pipe: ExtensionPipe, pageTargetId: string) {
  const { targetInfos } = await pipe.cdp.send("Target.getTargets", { filter: [{}] });
  for (const target of targetInfos.filter((target) => target.type === "tab")) {
    const { sessionId } = await pipe.send("Target.attachToTarget", { targetId: target.targetId });
    if (typeof sessionId !== "string") continue;
    let found = false;
    const attached = (method: string, params: Record<string, unknown>, parent: string) => {
      if (
        method === "Target.attachedToTarget" &&
        parent === sessionId &&
        (params.targetInfo as ExtensionTarget).targetId === pageTargetId
      )
        found = true;
    };
    pipe.on("event", attached);
    try {
      // Chrome announces attached children before acknowledging this command.
      await pipe.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      );
    } finally {
      pipe.off("event", attached);
      await pipe.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    if (found) return target.targetId;
  }
  throw new Error(
    "The host page has no owning Chrome tab target. Move it to the server browser and retry.",
  );
}

/** Exposes only one native extension target; disconnecting never closes its owning Chrome. */
export async function adoptExtensionTarget(
  pipe: ExtensionPipe,
  target: ExtensionTarget,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const token = NodeCrypto.randomUUID();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/${token}` });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const sockets = new Set<import("ws").WebSocket>();
  const releases = new Set<() => Promise<void>>();
  const info = {
    ...target,
    type: "page",
    attached: true,
    canAccessOpener: false,
    browserContextId: "cogenly-extension",
  };
  server.on("connection", (socket) => {
    sockets.add(socket);
    const sessions = new Set<string>();
    const browserSessions = new Set<string>();
    let announced = false;
    const write = (message: Message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const event = (method: string, params: Record<string, unknown>, sessionId: string) => {
      if (!sessions.has(sessionId)) return;
      if (method === "Target.attachedToTarget" && typeof params.sessionId === "string")
        sessions.add(params.sessionId);
      write({ method, params, sessionId });
    };
    const destroyed = ({ targetId }: { targetId: string }) => {
      if (targetId !== target.targetId) return;
      for (const sessionId of sessions)
        write({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
      socket.close();
    };
    pipe.on("event", event);
    pipe.cdp.on("Target.targetDestroyed", destroyed);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      pipe.off("event", event);
      pipe.cdp.off("Target.targetDestroyed", destroyed);
      await Promise.allSettled(
        [...sessions].map((sessionId) => pipe.send("Target.detachFromTarget", { sessionId })),
      );
      releases.delete(release);
      sockets.delete(socket);
    };
    releases.add(release);
    socket.on("close", () => void release());
    socket.on("error", () => void release());
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as Message;
      const handle = async () => {
        const params = command.params ?? {};
        if (command.sessionId && !browserSessions.has(command.sessionId)) {
          return pipe.send(command.method!, params, command.sessionId).catch((cause: unknown) => {
            // Chrome owns a native popup's window size; it may reject document
            // emulation. Playwright still records the measured native viewport.
            if (
              command.method === "Emulation.setDeviceMetricsOverride" &&
              cause instanceof Error &&
              cause.message.includes("Target does not support metrics override")
            )
              return {};
            throw cause;
          });
        }
        switch (command.method) {
          case "Browser.getVersion":
            return pipe.send("Browser.getVersion");
          case "Target.getBrowserContexts":
            return { browserContextIds: [] };
          case "Target.getTargetInfo":
            return {
              targetInfo: params.targetId
                ? info
                : { targetId: "browser", type: "browser", title: "", url: "", attached: true },
            };
          case "Target.getTargets":
            return { targetInfos: [info] };
          case "Target.attachToBrowserTarget": {
            const sessionId = NodeCrypto.randomUUID();
            browserSessions.add(sessionId);
            return { sessionId };
          }
          case "Target.setAutoAttach": {
            if (announced) return {};
            announced = true;
            const result = await pipe.send("Target.attachToTarget", { targetId: target.targetId });
            const sessionId = String(result.sessionId);
            sessions.add(sessionId);
            write({ id: command.id, result: {}, sessionId: command.sessionId });
            write({
              method: "Target.attachedToTarget",
              params: { sessionId, targetInfo: info, waitingForDebugger: false },
              sessionId: command.sessionId,
            });
            return undefined;
          }
          case "Target.attachToTarget": {
            if (params.targetId !== target.targetId)
              throw new Error("Only this extension surface can be attached.");
            const result = await pipe.send("Target.attachToTarget", { targetId: target.targetId });
            sessions.add(String(result.sessionId));
            return result;
          }
          case "Target.closeTarget":
            return pipe.send("Target.closeTarget", { targetId: target.targetId });
          case "Target.detachFromTarget":
            sessions.delete(String(params.sessionId));
            return pipe.send("Target.detachFromTarget", params);
          case "Target.setDiscoverTargets":
          case "Browser.grantPermissions":
          case "Browser.resetPermissions":
            return {};
          case "Browser.setDownloadBehavior": {
            const { browserContextId: _ignored, ...rest } = params;
            return pipe.send(command.method, rest);
          }
          default:
            throw new Error(`Unsupported extension browser command: ${command.method}`);
        }
      };
      void handle().then(
        (result) => {
          if (result !== undefined) write({ id: command.id, result, sessionId: command.sessionId });
        },
        (cause: Error) =>
          write({
            id: command.id,
            error: { message: cause.message },
            sessionId: command.sessionId,
          }),
      );
    });
  });
  const close = async () => {
    const connectedSockets = [...sockets];
    await Promise.allSettled([...releases].map((release) => release()));
    for (const socket of connectedSockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Extension relay did not bind.");
    await pipe.cdp.send("Target.setDiscoverTargets", { discover: true, filter: [{}] });
    const { chromium } = requirePlaywright("playwright-core") as typeof import("playwright-core");
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${address.port}/${token}`, {
      timeout: 10_000,
    });
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("The extension surface closed before it attached.");
    return {
      page,
      close: async () => {
        await close();
        await browser.close().catch(() => {});
      },
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

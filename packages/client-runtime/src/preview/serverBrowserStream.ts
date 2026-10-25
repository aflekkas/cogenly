// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  type PreviewAnnotationPayload,
  type PreviewStreamCapabilities,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@cogenly/contracts";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  /**
   * An agent opened or has used the tab, so the viewer in control can hand it
   * back with `handBack`. Older servers omit it, which reads as false.
   */
  readonly agentInvolved: boolean;
  readonly generation: number;
  /** Absent from older servers; a missing flag means unsupported. */
  readonly capabilities?: PreviewStreamCapabilities;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

/** Toolbar commands any operator may send; the server takes control for them first. */
const PAGE_COMMANDS: ReadonlySet<PreviewStreamInput["type"]> = new Set([
  "navigate",
  "history",
  "reload",
]);

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

const isPickHoverBox = (value: unknown): value is PreviewStreamPickHover["box"] =>
  value === null ||
  (typeof value === "object" &&
    value !== null &&
    "x" in value &&
    typeof value.x === "number" &&
    "y" in value &&
    typeof value.y === "number" &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number");

const isPickHoverLabel = (value: unknown): value is PreviewStreamPickHover["label"] =>
  value === null || typeof value === "string";

/** Structural pass: the annotation pipeline validates the payload it keeps. */
const isPickResultAnnotation = (value: unknown): value is PreviewAnnotationPayload =>
  typeof value === "object" && value !== null;

const normalizeCapabilities = (value: unknown): PreviewStreamCapabilities | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const pick = "pick" in value ? value.pick : undefined;
  if (pick === undefined) return undefined;
  return typeof pick === "boolean" ? { pick } : undefined;
};

/** Client-to-server messages. Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  /** The viewer in control gives the page back to the agent; needs `agentInvolved`. */
  | { readonly type: "handBack" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  /** Asks whether the page point takes text. Touch viewers send it on touch start. */
  | { readonly type: "probe"; readonly x: number; readonly y: number }
  /** Element picking: hover probe, element commit, and region commit. Page CSS px. */
  | { readonly type: "pickHitTest"; readonly x: number; readonly y: number }
  | { readonly type: "pickCommit"; readonly x: number; readonly y: number }
  | {
      readonly type: "pickCommitRegion";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  /** The input's `accept` attribute, ready for a local `<input type=file>`. */
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  /** Cookie sessions must send credentials with the upload. */
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

/** Sends files to a page's open picker. Rejects when the server refuses them. */
export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

/** A file a server tab downloaded, served with the stream's own access. */
export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

/** Answer to a `probe`, echoing its point. */
export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

/** Where an agent action is about to land, in page CSS pixels. */
export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
  /** The element the agent acts on, in viewport CSS pixels; null when it acts on a point. */
  readonly box: PreviewStreamPickHover["box"];
}

/** Answer to `pickHitTest`: hovered element box and label, both null on a miss. */
export interface PreviewStreamPickHover {
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly label: string | null;
}

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
  /**
   * Paces this viewer to at most one frame per interval. The server's screencast
   * waits for each ack, so holding acks back slows capture at the source instead
   * of dropping frames here. Thumbnails use it; omitted, every frame is acked at once.
   */
  readonly minFrameIntervalMs?: number;
  /** JPEG quality, 1 to 100; the server's default when omitted. */
  readonly quality?: number;
}

export interface PreviewStreamEvents {
  /** One complete JPEG frame. */
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  /** The agent's cursor moved to, or clicked at, a page point. */
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  /** Answer to `pickHitTest`; draw the highlight from it. */
  readonly onPickHover?: (hover: PreviewStreamPickHover) => void;
  /** Answer to `pickCommit` / `pickCommitRegion`: a full annotation. */
  readonly onPickResult?: (annotation: PreviewAnnotationPayload) => void;
  /** A commit that captured nothing. */
  readonly onPickError?: (message: string) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  /** Text the page just copied or cut while this viewer had control. */
  readonly onClipboard?: (text: string) => void;
  /** A file the page downloaded while this viewer had control. */
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  /** The page this viewer controls opened a new tab (a link or `window.open`). */
  readonly onPopup?: (tabId: string) => void;
  /** The page opened a file picker (`null` once answered or replaced). */
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  /** Input sent while disconnected is dropped. */
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  /** The tab was closed on the server. The client has stopped. */
  readonly onGone?: () => void;
  /** The server's browser cannot start until its host is set up. The client has stopped. */
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  /** False when the socket is not open and the message was dropped. */
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  if (target.quality !== undefined) query.set("quality", String(Math.round(target.quality)));
  const url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;
  const frameIntervalMs = Math.max(0, target.minFrameIntervalMs ?? 0);
  // Paced acks owed on the current socket, released one per interval.
  let pendingAcks = 0;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPendingAcks = () => {
    pendingAcks = 0;
    if (ackTimer !== null) clearTimeout(ackTimer);
    ackTimer = null;
  };
  const releaseAck = () => {
    ackTimer = null;
    if (pendingAcks === 0) return;
    pendingAcks -= 1;
    if (socket?.readyState === WebSocket.OPEN) socket.send(ACK_MESSAGE);
    if (pendingAcks > 0) ackTimer = setTimeout(releaseAck, frameIntervalMs);
  };
  const acknowledgeFrame = (ws: WebSocket) => {
    if (frameIntervalMs === 0) {
      ws.send(ACK_MESSAGE);
      return;
    }
    pendingAcks += 1;
    ackTimer ??= setTimeout(releaseAck, frameIntervalMs);
  };

  const connect = () => {
    if (stopped) return;
    clearPendingAcks();
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        acknowledgeFrame(ws);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        agentInvolved,
        generation,
        capabilities,
        dialog,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
        box,
        label,
        annotation,
        message: errorMessage,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        // Older servers send no box; the cursor still moves without an outline.
        events.onPointer?.({ phase, x, y, sequence, box: isPickHoverBox(box) ? box : null });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (type === "pickHover" && isPickHoverBox(box) && isPickHoverLabel(label)) {
        events.onPickHover?.({ box, label });
      } else if (type === "pickResult" && isPickResultAnnotation(annotation)) {
        events.onPickResult?.(annotation);
      } else if (type === "pickError" && typeof errorMessage === "string") {
        events.onPickError?.(errorMessage);
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const parsedCapabilities = normalizeCapabilities(capabilities);
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          agentInvolved: agentInvolved === true,
          generation,
          ...(parsedCapabilities === undefined ? {} : { capabilities: parsedCapabilities }),
          dialog,
        };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      clearPendingAcks();
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      // Picking asks questions about the page without driving it, so it never
      // needs control, and toolbar page commands take it on the server. Page
      // input still waits for it.
      const needsControl =
        input.type !== "takeControl" &&
        input.type !== "pickHitTest" &&
        input.type !== "pickCommit" &&
        input.type !== "pickCommitRegion" &&
        !PAGE_COMMANDS.has(input.type);
      if (needsControl && control.controller !== "you") return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearPendingAcks();
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      // A frame that fails to decode is skipped; the next one repaints.
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

/** A malformed reason still stops the viewer and offers the usual command. */
const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo cogenly browser setup" };
};

/** What a viewer tells the person; `command` is shown beside it, ready to copy. */
export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";

/**
 * Computer use on the environment's own machine. Every transport (the
 * `computer_*` MCP tools, the WebSocket RPCs behind Settings and the thread
 * prompt, the health report) calls this one service.
 */
import {
  COMPUTER_USE_PERMISSION_SETTINGS_URLS,
  COMPUTER_USE_PERMISSION_TITLES,
  ComputerDisplay,
  ComputerToolActionResult,
  ComputerToolAppsResult,
  ComputerToolUiResult,
  type ComputerToolClickInput,
  type ComputerToolDragInput,
  type ComputerToolKeyInput,
  type ComputerToolOpenAppInput,
  type ComputerToolPressInput,
  type ComputerToolScreenshotInput,
  type ComputerToolScreenshotResult,
  type ComputerToolScrollInput,
  type ComputerToolTypeInput,
  type ComputerToolUiInput,
  type ComputerUsePermission,
  type ComputerUseStatus,
  ComputerUseUnavailableError,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { ComputerHost } from "./ComputerHost.ts";
import { buildComputerUseStatus, type ComputerUseProbe } from "./ComputerUseStatus.ts";
import { parseKeyCombo } from "./macKeys.ts";

const ComputerUseProbeSchema = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
  displays: Schema.Number,
});
const decodeProbe = Schema.decodeUnknownEffect(ComputerUseProbeSchema);
const DisplaysReply = Schema.Struct({
  displays: Schema.Array(ComputerDisplay),
  frontmostApp: Schema.NullOr(Schema.String),
});

type Result<A> = Effect.Effect<A, ComputerUseUnavailableError>;

export class ComputerUse extends Context.Service<
  ComputerUse,
  {
    /** `enabled` overrides the machine setting, for callers that already resolved it (a thread's capability). */
    readonly status: (options?: {
      readonly enabled?: boolean;
      /** Narrow the report to the grant this `computer_*` tool needs. */
      readonly tool?: string | undefined;
    }) => Effect.Effect<ComputerUseStatus>;
    /** Asks macOS to list Cogenly under the grant, then opens its System Settings pane. */
    readonly requestPermission: (permission: ComputerUsePermission) => Result<ComputerUseStatus>;
    readonly screenshot: (
      input: ComputerToolScreenshotInput,
    ) => Result<ComputerToolScreenshotResult>;
    readonly apps: Result<ComputerToolAppsResult>;
    readonly openApp: (input: ComputerToolOpenAppInput) => Result<ComputerToolActionResult>;
    readonly ui: (input: ComputerToolUiInput) => Result<ComputerToolUiResult>;
    readonly press: (input: ComputerToolPressInput) => Result<ComputerToolActionResult>;
    readonly click: (input: ComputerToolClickInput) => Result<ComputerToolActionResult>;
    readonly type: (input: ComputerToolTypeInput) => Result<ComputerToolActionResult>;
    readonly key: (input: ComputerToolKeyInput) => Result<ComputerToolActionResult>;
    readonly scroll: (input: ComputerToolScrollInput) => Result<ComputerToolActionResult>;
    readonly drag: (input: ComputerToolDragInput) => Result<ComputerToolActionResult>;
  }
>()("cogenly-server/computerUse/ComputerUseService/ComputerUse") {}

/** What an agent reads when macOS refuses: the one thing the user must do, and what not to try. */
export function permissionMissingError(
  permission: ComputerUsePermission,
  hostApp: string | null,
): ComputerUseUnavailableError {
  const title = COMPUTER_USE_PERMISSION_TITLES[permission];
  const app = hostApp ?? "the app that started the Cogenly server";
  return new ComputerUseUnavailableError({
    code: "permission-missing",
    missing: [permission],
    reason: `macOS has not granted ${app} ${title} yet. The user has to turn it on once in System Settings → Privacy & Security → ${title}; this thread now shows them a button that opens that pane. Tell them that, then call computer_status after they say it is on; no restart is needed. Do not work around it with osascript, System Events or other scripts.`,
  });
}

const make = Effect.gen(function* () {
  const host = yield* ComputerHost;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const machineEnabled = Option.isNone(settings)
    ? Effect.succeed(true)
    : settings.value.getSettings.pipe(
        Effect.map((value) => value.enableAgentComputerUse),
        // Unreadable settings withhold access rather than grant it.
        Effect.orElseSucceed(() => false),
      );

  const probe: Effect.Effect<ComputerUseProbe | null> =
    host.platform !== "darwin"
      ? Effect.succeed(null)
      : host.script({ op: "probe" }).pipe(
          Effect.flatMap((reply) =>
            reply._tag === "ok" ? decodeProbe(reply.value) : Effect.succeed(null),
          ),
          Effect.orElseSucceed(() => null),
        );

  const status: ComputerUse["Service"]["status"] = (options) =>
    Effect.gen(function* () {
      const enabled = options?.enabled ?? (yield* machineEnabled);
      return buildComputerUseStatus({
        platform: host.platform,
        enabled,
        hostApp: host.hostApp,
        probe: host.platform === "darwin" ? yield* probe : null,
        tool: options?.tool,
      });
    });

  const requireMac = Effect.suspend(() => {
    if (host.platform === "darwin") return Effect.void;
    const report = buildComputerUseStatus({
      platform: host.platform,
      enabled: true,
      hostApp: null,
      probe: null,
    });
    return Effect.fail(
      new ComputerUseUnavailableError({
        code: "unsupported",
        reason: report.reason ?? "Computer use is not supported on this machine.",
      }),
    );
  });

  /** Runs one script op, mapping a refused grant to the agent-facing error and decoding the value. */
  const act = <A>(
    schema: Schema.Decoder<A>,
    input: { readonly op: string; readonly needs?: ComputerUsePermission } & Record<
      string,
      unknown
    >,
  ): Result<A> =>
    requireMac.pipe(
      Effect.andThen(host.script(input)),
      Effect.flatMap((reply) =>
        reply._tag === "missing"
          ? Effect.fail(permissionMissingError(reply.permission, host.hostApp))
          : Schema.decodeUnknownEffect(schema)(reply.value).pipe(
              Effect.mapError(
                (cause) =>
                  new ComputerUseUnavailableError({
                    code: "failed",
                    reason: "The computer-use helper returned an unexpected result.",
                    cause,
                  }),
              ),
            ),
      ),
    );

  const action = (op: string, params: Record<string, unknown>) =>
    act(ComputerToolActionResult, { op, needs: "accessibility", ...params });

  const requestPermission: ComputerUse["Service"]["requestPermission"] = (permission) =>
    Effect.gen(function* () {
      yield* requireMac;
      // Registering first puts Cogenly in the pane's list, so the user only flips a switch.
      yield* host.script({ op: "request", permission }).pipe(Effect.ignore);
      yield* host.open([COMPUTER_USE_PERMISSION_SETTINGS_URLS[permission]]);
      return yield* status();
    });

  const screenshot: ComputerUse["Service"]["screenshot"] = (input) =>
    Effect.gen(function* () {
      const reply = yield* act(DisplaysReply, { op: "displays", needs: "screen-recording" });
      const display =
        reply.displays.find((entry) => entry.display === (input.display ?? 1)) ??
        (yield* new ComputerUseUnavailableError({
          code: "failed",
          reason: `There is no display ${input.display}. This Mac has ${reply.displays.length}.`,
        }));
      const png = yield* host.capture(display.display, display.width);
      return {
        display,
        displays: reply.displays,
        frontmostApp: reply.frontmostApp,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(png).toString("base64"),
          ...pngSize(png),
        },
      };
    });

  const openApp: ComputerUse["Service"]["openApp"] = (input) =>
    Effect.gen(function* () {
      yield* requireMac;
      const app = input.app.trim();
      const bundleId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(app);
      yield* host.open(bundleId ? ["-b", app] : ["-a", app]).pipe(
        Effect.mapError(
          () =>
            new ComputerUseUnavailableError({
              code: "failed",
              reason: `No app named ${app} is installed. Call computer_apps for running apps, or check the exact name in /Applications.`,
            }),
        ),
      );
      return yield* act(ComputerToolActionResult, { op: "activate", app }).pipe(
        Effect.orElseSucceed(() => ({ frontmostApp: null })),
      );
    });

  const key: ComputerUse["Service"]["key"] = (input) => {
    const combo = parseKeyCombo(input.key);
    return combo === undefined
      ? Effect.fail(
          new ComputerUseUnavailableError({
            code: "failed",
            reason: `Unknown key "${input.key}". Use names like return, escape, tab, space, delete, up, down, left, right, f1-f12, a letter or digit, with cmd, shift, option or ctrl joined by "+".`,
          }),
        )
      : action("key", { ...combo });
  };

  return ComputerUse.of({
    status,
    requestPermission,
    screenshot,
    apps: act(ComputerToolAppsResult, { op: "apps" }),
    openApp,
    ui: (input) => act(ComputerToolUiResult, { op: "ui", needs: "accessibility", ...input }),
    press: (input) => action("press", input),
    click: (input) => action("click", input),
    type: (input) => action("type", input),
    key,
    scroll: (input) => action("scroll", input),
    drag: (input) => action("drag", input),
  });
});

/** Width and height from the IHDR chunk; anything that is not a PNG reports 0×0. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

export const layer = Layer.effect(ComputerUse, make);

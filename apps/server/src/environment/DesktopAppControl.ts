// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
// @effect-diagnostics nodeBuiltinImport:off -- The desktop control socket is a Node net client at the adapter boundary.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  DesktopAppActivationResponse,
  type DesktopAppActivationRequest,
  type DesktopAppEnvironmentAdded,
  type DesktopAppMachinesPaired,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { parseAddEnvironmentRequest } from "@t3tools/shared/environmentLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** How long the CLI waits for an answer from the desktop app. */
export const DESKTOP_APP_RESPONSE_TIMEOUT_MS = 17_000;
/** Longer than the desktop's own ten-minute budget for connecting a host, so its answer arrives. */
export const DESKTOP_APP_ADD_ENVIRONMENT_TIMEOUT_MS = 10 * 60_000 + 15_000;
/** Longer than the desktop's two-minute budget for pairing machines. */
export const DESKTOP_APP_PAIR_MACHINES_TIMEOUT_MS = 2 * 60_000 + 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const isDesktopAppActivationResponse = Schema.is(DesktopAppActivationResponse);

/**
 * Sends one request to the desktop app's control socket and reads its answer. The socket is
 * the user's own (0600, in a 0700 directory), so reaching it is what makes a request local.
 * A `fallbackAddress` is tried when nothing listens at `address`.
 */
export function sendDesktopAppRequest(input: {
  readonly address: string;
  readonly fallbackAddress?: string;
  readonly request: DesktopAppActivationRequest;
  readonly timeoutMs?: number;
}): Promise<DesktopAppActivationResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppActivationResponse }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, input.timeoutMs ?? DESKTOP_APP_RESPONSE_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppActivationResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      finish({ type: "success", response: parsed });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppRequest({
            address: input.fallbackAddress,
            request: input.request,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

export class DesktopAppControlInvalidInputError extends Schema.TaggedError<DesktopAppControlInvalidInputError>()(
  "DesktopAppControlInvalidInputError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopAppControlUnreachableError extends Schema.TaggedError<DesktopAppControlUnreachableError>()(
  "DesktopAppControlUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the Cogenly desktop app on this machine. Open the desktop app, then try again. Run this on the computer with the desktop app, not on the server you are adding.";
  }
}

export class DesktopAppControlRequestFailedError extends Schema.TaggedError<DesktopAppControlRequestFailedError>()(
  "DesktopAppControlRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    // The desktop validates requests itself, so one it cannot read comes from an older build.
    return this.code === "invalid-request"
      ? `The Cogenly desktop app could not read this request (${this.detail}). Update the desktop app, then try again.`
      : this.detail;
  }
}

export type DesktopAppControlError =
  | DesktopAppControlInvalidInputError
  | DesktopAppControlUnreachableError
  | DesktopAppControlRequestFailedError;

/**
 * The Cogenly desktop app on this machine, reached through its control socket. The CLI and
 * agents (`environment_add`) use it to add environments with no clicks; the desktop runs
 * its own SSH flow and saves the result.
 */
export class DesktopAppControl extends Context.Service<
  DesktopAppControl,
  {
    /** Connects an SSH host from the user's SSH config and saves it as an environment. */
    readonly addEnvironment: (input: {
      readonly ssh: string;
      readonly name?: string | undefined;
    }) => Effect.Effect<DesktopAppEnvironmentAdded, DesktopAppControlError>;
    /**
     * Pairs two machines the desktop app is connected to, as Settings → Machines
     * does. The app holds a session on both, which neither server has for the
     * other before pairing, so the join code never leaves the app.
     */
    readonly pairMachines: (input: {
      readonly hub: string;
      readonly joining: string;
    }) => Effect.Effect<DesktopAppMachinesPaired, DesktopAppControlError>;
  }
>()("cogenly-server/environment/DesktopAppControl") {}

/** Where the desktop app for a Cogenly home listens, and where its dev build would. */
export interface DesktopAppControlAddresses {
  readonly address: string;
  readonly fallbackAddress?: string;
}

/** The control address for a state directory (`<home>/userdata`, or `<home>/dev`). */
export const resolveControlAddress = Effect.fn("DesktopAppControl.resolveControlAddress")(
  function* (stateDir: string) {
    const path = yield* Path.Path;
    return resolveDesktopAppControlAddress({
      stateDir: path.resolve(stateDir),
      platform: yield* HostProcess.Platform,
      tempDir: NodeOS.tmpdir(),
      userId: yield* HostProcess.UserId,
      joinPath: path.join,
    }).address;
  },
);

const makeAt = (addresses: DesktopAppControlAddresses) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const candidateAddresses =
      addresses.fallbackAddress === undefined
        ? [addresses.address]
        : [addresses.address, addresses.fallbackAddress];

    /** Sends one request and returns the desktop's success, or its failure as an error. */
    const send = (
      makeRequest: (requestId: string) => DesktopAppActivationRequest,
      timeoutMs: number,
    ) =>
      Effect.gen(function* () {
        const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const response = yield* Effect.tryPromise({
          try: () =>
            sendDesktopAppRequest({ ...addresses, timeoutMs, request: makeRequest(requestId) }),
          catch: (cause) => new DesktopAppControlUnreachableError({ candidateAddresses, cause }),
        });
        if (!response.ok) {
          return yield* new DesktopAppControlRequestFailedError({
            code: response.code,
            detail: response.message,
          });
        }
        return response;
      });

    const differentAnswer = new DesktopAppControlRequestFailedError({
      code: "internal-error",
      detail: "The desktop app answered a different request.",
    });

    const addEnvironment = Effect.fn("DesktopAppControl.addEnvironment")(function* (input: {
      readonly ssh: string;
      readonly name?: string | undefined;
    }) {
      const parsed = parseAddEnvironmentRequest(input);
      if (!parsed.ok) {
        return yield* new DesktopAppControlInvalidInputError({ reason: parsed.error });
      }
      const response = yield* send(
        (requestId) => ({
          version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
          requestId,
          type: "add-environment",
          ssh: parsed.value.ssh,
          ...(parsed.value.name === null ? {} : { name: parsed.value.name }),
        }),
        DESKTOP_APP_ADD_ENVIRONMENT_TIMEOUT_MS,
      );
      if (!("environmentId" in response)) return yield* differentAnswer;
      return response;
    });

    const pairMachines = Effect.fn("DesktopAppControl.pairMachines")(function* (input: {
      readonly hub: string;
      readonly joining: string;
    }) {
      const hub = input.hub.trim();
      const joining = input.joining.trim();
      if (hub.length === 0 || joining.length === 0) {
        return yield* new DesktopAppControlInvalidInputError({
          reason: "Name both machines: the always-on hub and the machine joining it.",
        });
      }
      const response = yield* send(
        (requestId) => ({
          version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
          requestId,
          type: "pair-machines",
          hub,
          joining,
        }),
        DESKTOP_APP_PAIR_MACHINES_TIMEOUT_MS,
      );
      if (!("hub" in response)) return yield* differentAnswer;
      return response;
    });

    return DesktopAppControl.of({ addEnvironment, pairMachines });
  });

/** The desktop app that shares this server's Cogenly home, as the desktop-managed server does. */
export const layer = Layer.effect(
  DesktopAppControl,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const address = yield* resolveControlAddress(config.stateDir);
    return yield* makeAt({ address });
  }),
);

/** The desktop app at explicit addresses, for the CLI's `--base-dir` and dev fallback. */
export const layerAt = (addresses: DesktopAppControlAddresses) =>
  Layer.effect(DesktopAppControl, makeAt(addresses));

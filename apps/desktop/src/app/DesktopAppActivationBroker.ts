// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationFailure,
  type DesktopAppRendererRequest,
  type DesktopAppActivationResponse,
} from "@cogenly/contracts";

interface PendingActivation {
  readonly request: DesktopAppRendererRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

type RendererSender = (request: DesktopAppRendererRequest) => void;

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

/** Holds CLI requests until the real desktop renderer is ready to handle them. */
export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #requestTimeoutMs: (request: DesktopAppRendererRequest) => number;
  readonly #activate: () => void;
  #renderer: RendererSender | null = null;
  #closed = false;

  constructor(input: {
    /** How long the renderer gets for a request; adding an environment can take minutes. */
    readonly requestTimeoutMs: (request: DesktopAppRendererRequest) => number;
    readonly activate: () => void;
  }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#activate = input.activate;
  }

  request(request: DesktopAppRendererRequest): Promise<DesktopAppActivationResponse> {
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "Cogenly is shutting down."),
      );
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }

    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(
          failure(
            request.requestId,
            "request-timeout",
            request.type === "add-environment"
              ? "The desktop app did not finish adding the environment in time."
              : request.type === "pair-machines"
                ? "The desktop app did not finish pairing the machines in time."
                : "The desktop app did not finish opening the project in time.",
          ),
        );
      }, this.#requestTimeoutMs(request));
      this.#pending.set(request.requestId, {
        request,
        resolve,
        timeout,
        dispatched: false,
      });
    });

    this.#activate();
    this.#flush();
    return response;
  }

  registerRenderer(send: RendererSender): void {
    this.#renderer = send;
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      if (pending.dispatched) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The Cogenly window closed before it finished the request.",
          ),
        );
      }
    }
  }

  complete(response: DesktopAppActivationResponse): void {
    this.#settle(response);
  }

  cancel(requestId: string): void {
    this.#settle(
      failure(requestId, "renderer-unavailable", "The command closed before Cogenly was ready."),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(pending.request.requestId, "renderer-unavailable", "Cogenly is shutting down."),
      );
    }
  }

  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    if ([...this.#pending.values()].some((pending) => pending.dispatched)) return;

    for (const pending of this.#pending.values()) {
      if (pending.dispatched) continue;
      try {
        pending.dispatched = true;
        renderer(pending.request);
      } catch {
        pending.dispatched = false;
        this.#renderer = null;
      }
      return;
    }
  }

  #settle(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
    this.#flush();
  }
}

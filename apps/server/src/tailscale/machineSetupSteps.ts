/**
 * The machine setup checklist, derived from what was observed. Pure: the
 * MachineSetup service gathers the observation, and `planStep` names the
 * operation behind each step's button so the checklist and what the button
 * does cannot disagree.
 */
import type {
  MachineSetupHandoff,
  MachineSetupStatus,
  MachineSetupStep,
  MachineSetupStepId,
} from "@t3tools/contracts";
import { buildTailscaleHttpsBaseUrl } from "@t3tools/tailscale";

import {
  chooseServePort,
  type ServePortMapping,
  type TailscaleStatusSnapshot,
} from "./tailscaleState.ts";

export const TAILSCALE_INSTALL_SCRIPT = "curl -fsSL https://tailscale.com/install.sh | sh";
export const TAILSCALE_MAC_APP_STORE_URL = "https://apps.apple.com/app/tailscale/id1475387142";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
export const TAILSCALE_ADMIN_MACHINES_URL = "https://login.tailscale.com/admin/machines";
export const TAILSCALE_EXPLAINER =
  "Tailscale is a free app that gives your machines a private, encrypted link only you can use.";

export interface MachineSetupHost {
  readonly platform: string;
  readonly root: boolean;
  readonly passwordlessSudo: boolean;
  readonly homebrew: boolean;
}

/** What the service is doing or waiting on, kept in memory between checks. */
export interface MachineSetupProgress {
  readonly working: ReadonlySet<MachineSetupStepId>;
  /** Steps handed to the user (an App Store page opened, say) that finish once observed. */
  readonly handedOff: ReadonlySet<MachineSetupStepId>;
  /** Steps whose automatic attempt was refused for lack of privilege. */
  readonly needsPassword: ReadonlySet<MachineSetupStepId>;
  readonly loginUrl: string | null;
  readonly serveApprovalUrl: string | null;
  readonly problem: string | null;
}

export const emptyProgress: MachineSetupProgress = {
  working: new Set(),
  handedOff: new Set(),
  needsPassword: new Set(),
  loginUrl: null,
  serveApprovalUrl: null,
  problem: null,
};

export interface MachineSetupObservation {
  readonly machineName: string;
  readonly host: MachineSetupHost;
  readonly installed: boolean;
  readonly version: string | null;
  /** Null when the Tailscale daemon or app does not answer. */
  readonly status: TailscaleStatusSnapshot | null;
  /** Null when Serve's configuration could not be read. */
  readonly serveMappings: ReadonlyArray<ServePortMapping> | null;
  readonly localPort: number;
  /** Whether Cogenly accepts Serve's forwarded requests, and on which port. */
  readonly serveMode: {
    readonly enabled: boolean;
    readonly servePort: number;
    readonly localPort?: number;
  };
  readonly progress: MachineSetupProgress;
}

/** The operation behind a step's button. */
export type MachineSetupOperation =
  | "install-script"
  | "open-app-store"
  | "start-daemon"
  | "open-app"
  | "connect"
  | "login"
  | "serve"
  | "serve-off";

const isRunning = (status: TailscaleStatusSnapshot | null): status is TailscaleStatusSnapshot =>
  status !== null && status.backendState !== "Stopped";

const isSignedIn = (status: TailscaleStatusSnapshot | null) => status?.backendState === "Running";

/** What a step's button would do right now, or null when it has none. */
export const planStep = (
  step: MachineSetupStepId,
  observation: MachineSetupObservation,
): MachineSetupOperation | null => {
  const { host, status, progress } = observation;
  if (progress.needsPassword.has(step)) return null;
  const linux = host.platform === "linux";
  const darwin = host.platform === "darwin";
  const canSudo = host.root || host.passwordlessSudo;
  switch (step) {
    case "install":
      if (observation.installed) return null;
      return linux && canSudo ? "install-script" : darwin ? "open-app-store" : null;
    case "start":
      if (!observation.installed || isRunning(status)) return null;
      if (status === null) return darwin ? "open-app" : linux && canSudo ? "start-daemon" : null;
      return linux || darwin ? "connect" : null;
    case "sign-in":
      if (!isRunning(status) || isSignedIn(status)) return null;
      if (status.backendState === "NeedsMachineAuth") return null;
      return linux || darwin ? "login" : null;
    case "enable-https":
    case "expose":
      return isSignedIn(status) ? "serve" : null;
    case "disable-expose":
      return isSignedIn(status) ? "serve-off" : null;
  }
};

const commandHandoff = (command: string, reason: string): MachineSetupHandoff => ({
  _tag: "run-command",
  command,
  reason,
});

/** For a step Cogenly cannot do here: the exact thing the user does instead. */
const passwordHandoff = (
  step: MachineSetupStepId,
  observation: MachineSetupObservation,
): MachineSetupHandoff | null => {
  const { platform } = observation.host;
  const where = `Run this in a terminal on ${observation.machineName}. It asks for your password.`;
  switch (step) {
    case "install":
      return platform === "linux"
        ? commandHandoff(TAILSCALE_INSTALL_SCRIPT, where)
        : platform === "darwin"
          ? { _tag: "open-url", url: TAILSCALE_MAC_APP_STORE_URL, label: "Get Tailscale" }
          : { _tag: "open-url", url: TAILSCALE_DOWNLOAD_URL, label: "Download Tailscale" };
    case "start":
      return platform === "linux"
        ? commandHandoff(
            observation.status === null
              ? "sudo systemctl enable --now tailscaled"
              : "sudo tailscale up --operator=$USER",
            where,
          )
        : null;
    case "sign-in":
      return platform === "linux"
        ? commandHandoff("sudo tailscale up --operator=$USER", where)
        : null;
    case "enable-https":
    case "expose":
    case "disable-expose":
      return platform === "linux"
        ? commandHandoff(
            "sudo tailscale set --operator=$USER",
            `Run this once in a terminal on ${observation.machineName}. It asks for your password and lets Cogenly manage Tailscale Serve from then on.`,
          )
        : null;
  }
};

const step = (
  id: MachineSetupStepId,
  fields: Omit<MachineSetupStep, "id" | "action" | "handoff"> &
    Partial<Pick<MachineSetupStep, "action" | "handoff">>,
): MachineSetupStep => ({ id, action: null, handoff: null, ...fields });

const blocked = (id: MachineSetupStepId, title: string): MachineSetupStep =>
  step(id, { state: "blocked", title, detail: "Finish the step above first." });

/**
 * A step Cogenly can do, is doing, or hands off: the button comes from
 * `planStep`, and a refused attempt switches it to the password handoff.
 */
const actionable = (
  id: MachineSetupStepId,
  observation: MachineSetupObservation,
  fields: { title: string; detail: string; action: string },
): MachineSetupStep => {
  if (observation.progress.working.has(id)) {
    return step(id, { state: "working", title: fields.title, detail: fields.detail });
  }
  const operation = planStep(id, observation);
  return step(id, {
    state: observation.progress.handedOff.has(id) ? "waiting" : "todo",
    title: fields.title,
    detail: fields.detail,
    action: operation === null ? null : fields.action,
    handoff:
      operation === null || operation === "open-app-store"
        ? passwordHandoff(id, observation)
        : null,
  });
};

export const buildMachineSetupStatus = (
  observation: MachineSetupObservation,
  observedAt: MachineSetupStatus["observedAt"],
): MachineSetupStatus => {
  const { status, progress, machineName: name, host } = observation;
  const running = isRunning(status);
  const signedIn = isSignedIn(status);
  const choice =
    observation.serveMappings === null
      ? null
      : chooseServePort(
          observation.serveMappings,
          observation.localPort,
          observation.serveMode.servePort,
        );
  const funnel = choice?._tag === "ours" && choice.funnel;
  const servePort = choice?._tag === "ours" ? choice.port : observation.serveMode.servePort;
  const joinUrl =
    signedIn &&
    observation.serveMode.enabled &&
    choice?._tag === "ours" &&
    !funnel &&
    status?.magicDnsName != null
      ? buildTailscaleHttpsBaseUrl({ magicDnsName: status.magicDnsName, servePort })
      : null;
  const served = joinUrl !== null;
  const httpsEnabled = status?.httpsEnabled ?? null;

  const install: MachineSetupStep = observation.installed
    ? step("install", {
        state: "done",
        title: "Install Tailscale",
        detail:
          observation.version === null
            ? "Tailscale is installed."
            : `Tailscale ${observation.version} is installed.`,
      })
    : progress.working.has("install")
      ? step("install", {
          state: "working",
          title: "Install Tailscale",
          detail: `Installing Tailscale on ${name}. This can take a minute.`,
        })
      : actionable("install", observation, {
          title: "Install Tailscale",
          detail:
            host.platform === "darwin"
              ? `${TAILSCALE_EXPLAINER} Get it from the App Store on ${name}, then open it.${host.homebrew ? " With Homebrew, `brew install --cask tailscale-app` works too." : ""}`
              : `${TAILSCALE_EXPLAINER} It isn't on ${name} yet.`,
          action: host.platform === "darwin" ? "Open the App Store" : "Install Tailscale",
        });

  const start: MachineSetupStep = !observation.installed
    ? blocked("start", "Turn on Tailscale")
    : running
      ? step("start", {
          state: "done",
          title: "Turn on Tailscale",
          detail: "Tailscale is running.",
        })
      : actionable("start", observation, {
          title: "Turn on Tailscale",
          detail:
            status === null
              ? `Tailscale isn't running on ${name}. A machine that slept or restarted can leave it off.`
              : `Tailscale is turned off on ${name}.`,
          action:
            status === null && host.platform === "darwin" ? "Open Tailscale" : "Turn on Tailscale",
        });

  const signIn: MachineSetupStep = !running
    ? blocked("sign-in", "Sign in to Tailscale")
    : signedIn
      ? step("sign-in", {
          state: "done",
          title: "Sign in to Tailscale",
          detail:
            status.tailnetName === null ? "Signed in." : `Signed in to ${status.tailnetName}.`,
        })
      : status.backendState === "NeedsMachineAuth"
        ? step("sign-in", {
            state: "waiting",
            title: "Sign in to Tailscale",
            detail: `Your Tailscale admin needs to approve ${name}. This step finishes by itself.`,
            handoff: {
              _tag: "open-url",
              url: TAILSCALE_ADMIN_MACHINES_URL,
              label: "Approve in Tailscale",
            },
          })
        : (progress.loginUrl ?? status.authUrl) !== null
          ? step("sign-in", {
              state: "waiting",
              title: "Sign in to Tailscale",
              detail:
                "Finish signing in on the Tailscale page. Use the same account on each of your machines. This step finishes by itself.",
              handoff: {
                _tag: "open-url",
                url: (progress.loginUrl ?? status.authUrl)!,
                label: "Sign in to Tailscale",
              },
            })
          : actionable("sign-in", observation, {
              title: "Sign in to Tailscale",
              detail:
                "Sign in with the same account on each of your machines so they can find each other.",
              action: "Sign in",
            });

  const https: MachineSetupStep = !signedIn
    ? blocked("enable-https", "Turn on private HTTPS")
    : progress.serveApprovalUrl !== null
      ? step("enable-https", {
          state: "waiting",
          title: "Turn on private HTTPS",
          detail:
            "Approve HTTPS on the Tailscale page. Cogenly finishes setting up by itself afterward.",
          handoff: {
            _tag: "open-url",
            url: progress.serveApprovalUrl,
            label: "Approve in Tailscale",
          },
        })
      : httpsEnabled === true || served
        ? step("enable-https", {
            state: "done",
            title: "Turn on private HTTPS",
            detail: "HTTPS is on for your Tailscale network.",
          })
        : actionable("enable-https", observation, {
            title: "Turn on private HTTPS",
            detail:
              "Your Tailscale network needs HTTPS turned on once, so your machines connect over an encrypted address.",
            action: "Turn on HTTPS",
          });

  const exposeTitle = `Make ${name} reachable`;
  const expose: MachineSetupStep = !signedIn
    ? blocked("expose", exposeTitle)
    : served
      ? step("expose", {
          state: "done",
          title: exposeTitle,
          detail: `Your machines reach it privately at ${joinUrl}.`,
        })
      : funnel
        ? step("expose", {
            state: "todo",
            title: exposeTitle,
            detail:
              "Tailscale Funnel puts this Cogenly on the public internet. Turn Funnel off to pair machines.",
            handoff: commandHandoff(
              `tailscale funnel --https=${String(servePort)} off`,
              `Run this in a terminal on ${name}.`,
            ),
          })
        : choice?._tag === "none"
          ? step("expose", {
              state: "todo",
              title: exposeTitle,
              detail:
                "Tailscale Serve already uses every HTTPS port (443, 8443 and 10000) for something else. Free one with `tailscale serve status` and `tailscale serve --https=<port> off`.",
            })
          : progress.serveApprovalUrl !== null
            ? step("expose", {
                state: "waiting",
                title: exposeTitle,
                detail: "Waiting for HTTPS to be approved.",
              })
            : actionable("expose", observation, {
                title: exposeTitle,
                detail:
                  "Cogenly gives this machine a private address that only your machines can reach.",
                action: "Turn on",
              });

  const steps = [install, start, signIn, https, expose];
  return {
    observedAt,
    platform: host.platform,
    tailscale: {
      installed: observation.installed,
      version: observation.version,
      running,
      signedIn,
      tailnetName: status?.tailnetName ?? null,
      magicDnsName: status?.magicDnsName ?? null,
      httpsEnabled,
      served,
      servePort,
    },
    steps,
    ready: steps.every((entry) => entry.state === "done"),
    joinUrl,
    problem: progress.problem,
  };
};

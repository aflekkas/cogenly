import {
  EnvironmentId,
  type MachineInfo,
  type MachineListResult,
  type ProviderAuthState,
  ProviderInstanceId,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_SIGN_IN_LOCAL_INITIAL,
  providerMachineSignIns,
  providerNeedsSignIn,
  providerSignInForMachine,
  providerSignInStep,
  providersNeedingSignIn,
  shouldAutoStartProviderSignIn,
  type ProviderSignInLocal,
} from "./providerSignIn.ts";

const claude = ProviderInstanceId.make("claude-uchicago");
const mac = EnvironmentId.make("env-mac");
const vps = EnvironmentId.make("env-vps");

const machine = (
  environmentId: EnvironmentId,
  name: string,
  relation: MachineInfo["relation"],
  provider: Partial<MachineInfo["providers"][number]> | null,
): MachineInfo => ({
  environmentId,
  name,
  kind: relation === "this" ? "this-computer" : "cloud-server",
  hardware: "laptop",
  platform: "darwin",
  providers:
    provider === null
      ? []
      : [
          {
            instanceId: claude,
            displayName: "Claude (UChicago)",
            enabled: true,
            auth: "authenticated",
            ...provider,
          },
        ],
  relation,
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
});

const list: MachineListResult = {
  machines: [
    machine(mac, "MacBook", "this", { auth: "authenticated" }),
    machine(vps, "Contabo VPS", "hub", { auth: "unauthenticated" }),
    machine(EnvironmentId.make("env-pi"), "Pi", "peer", null),
  ],
  link: { _tag: "spoke", hubEnvironmentId: vps, status: "online", route: null, lastError: null },
};

describe("providerMachineSignIns", () => {
  it("lists one row per machine with the provider, the viewed machine first", () => {
    const rows = providerMachineSignIns({
      viaEnvironmentId: mac,
      list,
      instanceId: claude,
      currentEnvironmentId: vps,
    });
    expect(rows.map((row) => [row.machineName, row.auth, row.current])).toEqual([
      ["Contabo VPS", "unauthenticated", true],
      ["MacBook", "authenticated", false],
    ]);
    // Commands go through the connected server and name the paired machine as the target.
    expect(rows[0]).toMatchObject({ environmentId: mac, targetEnvironmentId: vps });
    expect(rows[1]).not.toHaveProperty("targetEnvironmentId");
  });

  it("offers sign-in only on a signed-out, reachable machine that can sign in here", () => {
    const vpsSignIn = providerSignInForMachine({
      viaEnvironmentId: mac,
      list,
      instanceId: claude,
      machineEnvironmentId: vps,
    });
    expect(vpsSignIn?.machineName).toBe("Contabo VPS");
    expect(providerNeedsSignIn(vpsSignIn)).toBe(true);
    expect(providerNeedsSignIn({ ...vpsSignIn!, online: false })).toBe(false);
    // Muse reports it can't sign in from Cogenly: no broken Sign in button.
    expect(providerNeedsSignIn({ ...vpsSignIn!, canSignIn: false })).toBe(false);
    // The model picker marks what the thread's machine still needs.
    expect(
      providersNeedingSignIn({ viaEnvironmentId: mac, list, machineEnvironmentId: vps }).map(
        (entry) => [entry.instanceId, entry.targetEnvironmentId],
      ),
    ).toEqual([[claude, vps]]);
    expect(
      providersNeedingSignIn({ viaEnvironmentId: mac, list, machineEnvironmentId: null }),
    ).toEqual([]);
    expect(
      providerNeedsSignIn(
        providerSignInForMachine({
          viaEnvironmentId: mac,
          list,
          instanceId: claude,
          machineEnvironmentId: null,
        }),
      ),
    ).toBe(false);
  });
});

const state = (patch: Partial<ProviderAuthState>): ProviderAuthState => ({
  instanceId: claude,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  interaction: null,
  methods: [],
  ...patch,
});

const step = (
  auth: ProviderAuthState | undefined,
  local: Partial<ProviderSignInLocal> = {},
  providerAuth: "authenticated" | "unauthenticated" = "unauthenticated",
) =>
  providerSignInStep({
    auth,
    providerAuth,
    canSignIn: true,
    local: { ...PROVIDER_SIGN_IN_LOCAL_INITIAL, ...local },
  });

const claudeCode = {
  type: "credentials" as const,
  id: "cli-code",
  url: "https://claude.ai/oauth/authorize?x=1",
  fields: [{ name: "code", label: "Code from the sign-in page", secret: true }],
};

describe("providerSignInStep", () => {
  it("walks Claude from ready to the code step to checking to success", () => {
    const ready = step(state({}));
    expect(ready).toEqual({ kind: "ready" });
    expect(shouldAutoStartProviderSignIn(ready)).toBe(true);
    expect(step(state({}), { starting: true })).toEqual({ kind: "starting" });
    // The machine has not reported the flow it just started yet: still starting, not ready.
    expect(step(state({}), { startedFlowId: "flow-1" })).toEqual({ kind: "starting" });
    const waiting = state({ phase: "waiting", flowId: "flow-1", interaction: claudeCode });
    expect(step(waiting, { startedFlowId: "flow-1" })).toMatchObject({
      kind: "code",
      url: claudeCode.url,
      submitting: false,
    });
    expect(step(waiting, { startedFlowId: "flow-1", responding: true })).toMatchObject({
      kind: "code",
      submitting: true,
    });
    // Once the machine accepted the code, the step says it is checking, not asking again.
    expect(
      step(waiting, { startedFlowId: "flow-1", answeredInteraction: "flow-1:cli-code" }),
    ).toEqual({ kind: "verifying" });
    expect(
      step(state({ phase: "succeeded", flowId: "flow-1" }), { startedFlowId: "flow-1" }),
    ).toEqual({ kind: "succeeded" });
  });

  it("shows Codex's device code and waits for approval without a field", () => {
    expect(
      step(
        state({
          phase: "waiting",
          flowId: "flow-2",
          interaction: {
            type: "deviceCode",
            id: "cli-login",
            url: "https://auth.openai.com/codex/device",
            userCode: "ABCD-12345",
          },
        }),
        { startedFlowId: "flow-2" },
      ),
    ).toEqual({
      kind: "device-code",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    });
  });

  it("reports failure, cancellation and command errors honestly", () => {
    expect(
      step(state({ phase: "failed", flowId: "flow-3", message: "Sign-in expired. Start again." }), {
        startedFlowId: "flow-3",
      }),
    ).toEqual({ kind: "failed", message: "Sign-in expired. Start again." });
    expect(
      step(state({ phase: "cancelled", flowId: "flow-3" }), { startedFlowId: "flow-3" }),
    ).toEqual({ kind: "cancelled" });
    expect(
      step(state({}), { error: "The paired machine could not complete this sign-in." }),
    ).toEqual({ kind: "failed", message: "The paired machine could not complete this sign-in." });
  });

  it("does not treat another flow's leftovers as this sign-in", () => {
    // An old failure or success from before this client started is not shown as its result.
    expect(step(state({ phase: "failed", flowId: "old", message: "Old" }))).toEqual({
      kind: "ready",
    });
    expect(step(state({ phase: "succeeded", flowId: "old" }))).toEqual({ kind: "ready" });
    // Already signed in when the flow opens: nothing to do.
    expect(step(state({}), {}, "authenticated")).toEqual({ kind: "succeeded" });
    // Another client is signing in; this one watches instead of starting a second flow.
    const elsewhere = step(state({ phase: "waiting", flowId: null }));
    expect(elsewhere).toEqual({ kind: "elsewhere" });
    expect(shouldAutoStartProviderSignIn(elsewhere)).toBe(false);
  });

  it("asks which method when the provider offers several, and never for an external one", () => {
    const methods = [
      { id: "a", name: "A", description: null, type: "agent" as const },
      { id: "b", name: "B", description: null, type: "agent" as const },
    ];
    const choose = step(state({ methods }));
    expect(choose).toEqual({ kind: "choose-method", methods });
    expect(shouldAutoStartProviderSignIn(choose)).toBe(false);
    expect(
      providerSignInStep({
        auth: state({}),
        providerAuth: "unauthenticated",
        canSignIn: false,
        local: PROVIDER_SIGN_IN_LOCAL_INITIAL,
      }),
    ).toEqual({ kind: "unsupported" });
  });
});

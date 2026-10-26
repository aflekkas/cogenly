import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import {
  applyProviderSettings,
  encodeProviderSettings,
  providerSettingsCodec,
} from "./providerSettingsDocument.ts";
import { planSettingsReconcile, settingsBaseKey } from "./settingsReconcile.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const id = ProviderInstanceId.make("claude-personal");
const account = "a".repeat(64);
const work = "b".repeat(64);

describe("portable provider configuration", () => {
  it("excludes sensitive variables, machine paths, command arguments and opaque credentials", () => {
    const value = encodeProviderSettings({
      driver,
      displayName: "Personal",
      enabled: false,
      environment: [
        { name: "LANG", value: "en_US.UTF-8", sensitive: false },
        { name: "API_KEY", value: "DO_NOT_REPLICATE", sensitive: true },
        { name: "OPENAI_API_KEY", value: "DO_NOT_REPLICATE", sensitive: false },
      ],
      config: {
        homePath: "/local/home",
        binaryPath: "/local/cli",
        launchArgs: "--token DO_NOT_REPLICATE",
        password: "DO_NOT_REPLICATE",
        customModels: ["my-model"],
      },
    });
    expect(value).toEqual({
      driver,
      displayName: "Personal",
      enabled: false,
      environment: [{ name: "LANG", value: "en_US.UTF-8", sensitive: false }],
      customModels: ["my-model"],
    });
    expect(
      Option.isNone(
        providerSettingsCodec.decode({
          driver,
          environment: [{ name: "KEY", value: "secret", sensitive: true }],
          customModels: [],
        }),
      ),
    ).toBe(true);
  });

  it("excludes secret-looking names that only contain a keyword, not a delimited token", () => {
    const value = encodeProviderSettings({
      driver,
      environment: [
        { name: "LANG", value: "en_US.UTF-8", sensitive: false },
        { name: "ANTHROPIC_APIKEY", value: "DO_NOT_REPLICATE", sensitive: false },
        { name: "UPSTREAM_AUTH", value: "DO_NOT_REPLICATE", sensitive: false },
        { name: "SESSION", value: "DO_NOT_REPLICATE", sensitive: false },
      ],
      config: {},
    });
    expect(value).toEqual({
      driver,
      environment: [{ name: "LANG", value: "en_US.UTF-8", sensitive: false }],
      customModels: [],
    });
    expect(JSON.stringify(value)).not.toContain("DO_NOT_REPLICATE");
  });

  it("never replicates executable environment variables", () => {
    const dangerous = [
      "NODE_OPTIONS",
      "BASH_ENV",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "PATH",
    ];
    const value = encodeProviderSettings({
      driver,
      environment: [
        ...dangerous.map((name) => ({ name, value: "EVIL", sensitive: false })),
        { name: "TZ", value: "Europe/London", sensitive: false },
        { name: "NO_COLOR", value: "1", sensitive: false },
      ],
      config: {},
    });
    expect(JSON.stringify(value)).not.toContain("EVIL");
    expect(value).toMatchObject({
      environment: [
        { name: "TZ", value: "Europe/London", sensitive: false },
        { name: "NO_COLOR", value: "1", sensitive: false },
      ],
    });
    // A poisoned document received from a peer is ignored on apply, and
    // machine-local variables survive untouched.
    const applied = applyProviderSettings(
      {
        driver,
        environment: [
          ...dangerous.map((name) => ({ name, value: "EVIL", sensitive: false as const })),
          { name: "TZ", value: "UTC", sensitive: false as const },
        ],
        customModels: [],
      },
      {
        driver,
        environment: [{ name: "PATH", value: "/local/bin", sensitive: false }],
        config: {},
      },
      id,
    );
    expect(JSON.stringify(applied?.environment)).not.toContain("EVIL");
    expect(applied?.environment).toEqual([
      { name: "TZ", value: "UTC", sensitive: false },
      { name: "PATH", value: "/local/bin", sensitive: false },
    ]);
  });

  it("keeps machine-local paths and sensitive environment when applying remote edits", () => {
    const local = {
      driver,
      config: { homePath: "/local/home", binaryPath: "/local/cli", password: "local-secret" },
      environment: [{ name: "KEY", value: "local-secret", sensitive: true }],
    };
    expect(
      applyProviderSettings(
        encodeProviderSettings({
          driver,
          displayName: "Renamed",
          environment: [{ name: "LANG", value: "C", sensitive: false }],
        }),
        local,
        id,
      ),
    ).toEqual({
      driver,
      displayName: "Renamed",
      config: { ...local.config, customModels: [] },
      environment: [{ name: "LANG", value: "C", sensitive: false }, ...local.environment],
    });
    expect(
      applyProviderSettings(encodeProviderSettings({ driver }), undefined, id)?.config,
    ).toMatchObject({ homePath: "~/.cogenly/provider-homes/claude-personal" });
  });

  it("aligns the owner's VPS Personal login with the Mac's canonical Personal ID", () => {
    const fields = {
      "provider:claude-personal": encodeProviderSettings(
        { driver, displayName: "Claude (Personal)" },
        account,
        0,
      ),
      "provider:claudeAgent": encodeProviderSettings(
        { driver, displayName: "Claude (UChicago)" },
        work,
        1,
      ),
    };
    const plan = planSettingsReconcile({
      settings: DEFAULT_SERVER_SETTINGS,
      base: new Map(),
      documents: new Map([["universal", fields]]),
      accounts: new Map([
        ["claudeAgent", { identity: account, homePath: "/home/dev/.claude", driver }],
      ]),
    });
    expect(plan.settings?.providerInstances[id]?.config).toMatchObject({
      homePath: "/home/dev/.claude",
      syncAccountIdentity: account,
    });
    expect(
      plan.settings?.providerInstances[ProviderInstanceId.make("claudeAgent")]?.config,
    ).toMatchObject({
      homePath: `~/.cogenly/provider-homes/claudeAgent/${work.slice(0, 16)}`,
      syncAccountIdentity: work,
    });
    expect(Object.keys(plan.settings?.providerInstances ?? {})).toEqual([
      "claude-personal",
      "claudeAgent",
    ]);
    expect(plan.publish.size).toBe(0);
  });

  it("keeps unrelated accounts, propagates removal and allows re-creation", () => {
    const instance = { driver, displayName: "Personal" };
    const value = encodeProviderSettings(instance, undefined, 0);
    const base = new Map([[settingsBaseKey("universal", "", `provider:${id}`), value]]);
    const settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [id]: instance } };
    const removed = planSettingsReconcile({
      settings,
      base,
      documents: new Map([["universal", { [`provider:${id}`]: null }]]),
    });
    expect(removed.settings?.providerInstances).toEqual({});
    const recreated = planSettingsReconcile({
      settings: removed.settings!,
      base: new Map([[settingsBaseKey("universal", "", `provider:${id}`), null]]),
      documents: new Map([["universal", { [`provider:${id}`]: value }]]),
    });
    expect(recreated.settings?.providerInstances[id]?.displayName).toBe("Personal");
  });
  it("a peer's later account change requires a fresh home instead of silently using the old login", () => {
    const previous = encodeProviderSettings({ driver }, account, 0);
    const incoming = encodeProviderSettings({ driver }, work, 0);
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [id]: { driver, config: { homePath: "/old-login", syncAccountIdentity: account } },
      },
    };
    const plan = planSettingsReconcile({
      settings,
      base: new Map([[settingsBaseKey("universal", "", `provider:${id}`), previous]]),
      documents: new Map([["universal", { [`provider:${id}`]: incoming }]]),
      accounts: new Map([[id, { identity: account, homePath: "/old-login", driver }]]),
    });
    expect(plan.settings?.providerInstances[id]?.config).toMatchObject({
      homePath: `~/.cogenly/provider-homes/${id}/${work.slice(0, 16)}`,
      syncAccountIdentity: work,
    });
    expect(plan.publish.size).toBe(0);
  });
});

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  isUsageLimitsCommand,
  collectProviderUsageLimits,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  remainingPercent,
  usesChatGptSharing,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it.each([
    ["2026-09-03T12:01:00.000Z", "resets in 1m"],
    ["2026-09-03T12:00:59.999Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.001Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.000Z", "resets now"],
    ["2026-09-03T11:59:59.999Z", "resets now"],
  ])("formats the reset boundary at %s", (resetsAt, label) => {
    expect(formatResetsIn({ ...window, resetsAt }, now)).toBe(label);
  });

  it("ignores invalid reset timestamps", () => {
    expect(formatResetsIn({ ...window, resetsAt: "invalid" }, now)).toBeNull();
  });

  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "resets now",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("pools", () => {
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("shows one Muse login read by two environments as one column per window", () => {
    // Muse has no auth signal, only the email from its credential file.
    const muse = provider({
      driver: ProviderDriverKind.make("muse"),
      instanceId: ProviderInstanceId.make("muse"),
      displayName: "Muse Code",
      auth: { status: "unknown", email: "someone@example.com" },
      usageLimits: {
        checkedAt,
        windows: [
          { ...window, id: "window", usedPercent: 0 },
          { ...weekly, id: "weekly", usedPercent: 43 },
        ],
      },
    });
    const environments = (providers: readonly ServerProvider[]) =>
      new Map([
        [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers } }],
        [
          EnvironmentId.make("env-b"),
          { entry: { target: { label: "Dev" } }, serverConfig: { providers } },
        ],
      ]);

    const [pool] = collectLimitPools(collectLimitAccounts(environments([muse])), now);
    expect(pool?.windows.map((pooled) => [pooled.kind, pooled.columns.length])).toEqual([
      ["session", 1],
      ["weekly", 1],
    ]);
    expect(pool?.accounts[0]?.environments.map((environment) => environment.label)).toEqual([
      "Laptop",
      "Dev",
    ]);

    // Without an account identity the two reads cannot be told apart from two logins.
    const anonymous = { ...muse, auth: { status: "unknown" as const } };
    const [split] = collectLimitPools(collectLimitAccounts(environments([anonymous])), now);
    expect(split?.windows[0]?.columns).toHaveLength(2);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("names an environment once however many of its instances share the account", () => {
    const shared = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [shared, { ...shared, instanceId: ProviderInstanceId.make("work") }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input)[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
    ]);
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],

    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });

  it("sorts unknown resets last and breaks ties consistently", () => {
    const accounts = [
      account("z", [{ ...window, resetsAt: undefined }]),
      account("b", [window]),
      account("a", [window]),
      account("y", [{ ...window, resetsAt: "invalid" }]),
    ];
    expect(keys(collectLimitPools(accounts, now)[0]!)).toEqual([["a", "b", "y", "z"]]);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual([["a", "b", "y", "z"]]);
  });
});

describe("collectLimitNotices", () => {
  it("reports native probe failures and skips unsupported accounts", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    const presentations = new Map([
      [
        EnvironmentId.make("laptop"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers: [
              provider({
                usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
              }),
              provider({
                usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
              }),
            ],
          },
        },
      ],
    ]);
    expect(collectLimitNotices(presentations)).toEqual(["codex: Could not read limits."]);
  });
});

describe("/usage-limits", () => {
  const limits = {
    checkedAt: "2026-09-03T11:00:00.000Z",
    windows: [window],
    resetCredits: { availableCount: 2 },
  };
  const selected = provider({ usageLimits: limits });
  it("reports native accounts with native reset targets", () => {
    const other = provider({
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
      usageLimits: limits,
    });
    const report = collectProviderUsageLimits(selected.instanceId, [selected, other], now);
    expect(report?.accounts).toHaveLength(1);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      resetCreditInput: { instanceId: selected.instanceId },
      limits,
    });
    expect(
      collectProviderUsageLimits(selected.instanceId, [{ ...selected, enabled: false }], now),
    ).toBeNull();
  });
  it("advertises on global and workspace catalogs only when native limits exist", () => {
    const withWorkspace = {
      ...selected,
      workspaceSnapshots: [
        { cwd: "/repo", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    };
    const [offered] = withUsageLimitsCommands([withWorkspace]);
    expect(offered?.slashCommands.map((command) => command.name)).toContain("usage-limits");
    expect(
      offered?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toContain("usage-limits");
    expect(withUsageLimitsCommands([provider({})])[0]?.slashCommands).toEqual([]);
  });
});

describe("remainingPercent", () => {
  it("inverts and clamps the reported usage", () => {
    expect(remainingPercent(window)).toBe(60);
    expect(remainingPercent({ ...window, usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ ...window, usedPercent: 100 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: 33.4 })).toBe(67);
  });
});

describe("isUsageLimitsCommand", () => {
  it("recognizes only the standalone local action", () => {
    expect(isUsageLimitsCommand("  /USAGE-LIMITS\n")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits explain")).toBe(false);
    expect(isUsageLimitsCommand("Explain /usage-limits")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });
  it("omits disabled, uninstalled and signed-out providers", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [
              { ...managed, enabled: false },
              { ...managed, installed: false },
              { ...managed, auth: { status: "unauthenticated" as const } },
              provider({}),
            ],
          },
        },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([]);
  });
});

describe("ChatGPT sharing presentation", () => {
  it("requires verified sharing metadata rather than the Codex driver or login type", () => {
    const codex = provider({ auth: { status: "authenticated", type: "chatgpt" } });
    expect(usesChatGptSharing(codex)).toBe(false);
    expect(
      usesChatGptSharing({ ...codex, auth: { ...codex.auth, subscriptionSharing: true } }),
    ).toBe(true);
    expect(
      usesChatGptSharing({
        ...codex,
        auth: { status: "unauthenticated", subscriptionSharing: true },
      }),
    ).toBe(false);
  });
});

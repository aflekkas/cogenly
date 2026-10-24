import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { splitSharedServerPatch } from "@t3tools/client-runtime/state/shared-settings";
import { DEFAULT_APPEARANCE_PREFERENCES } from "./appearancePreferences";
import { DEFAULT_APPEARANCE_MODE } from "./theme";
import {
  clientPreferenceValues,
  clientSettingsPatchFromPreferences,
  planClientPreferenceSync,
  settleClientPreferenceWrite,
} from "./sharedClientPreferences";

const defaults = clientPreferenceValues(
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_APPEARANCE_MODE,
);

describe("universal client preferences", () => {
  it("never publishes a new client's untouched defaults", () => {
    const plan = planClientPreferenceSync(defaults, DEFAULT_SERVER_SETTINGS, new Map());
    expect(plan.patch).toEqual({});
    expect(plan.apply).toEqual({});
    const received = planClientPreferenceSync(
      defaults,
      {
        ...DEFAULT_SERVER_SETTINGS,
        clientAppearanceAccent: "violet",
        clientFollowUpBehavior: "queue",
      },
      plan.next,
    );
    expect(received.patch).toEqual({});
    expect(received.apply).toEqual({
      clientAppearanceAccent: "violet",
      clientFollowUpBehavior: "queue",
    });
  });

  it("migrates legacy customizations per field while adopting already shared choices", () => {
    const plan = planClientPreferenceSync(
      {
        ...defaults,
        clientAppearanceAccent: "blue",
        clientWordWrap: false,
        clientNotificationMode: "notifications",
      },
      { ...DEFAULT_SERVER_SETTINGS, clientAppearanceAccent: "green", clientWordWrap: true },
      new Map(),
    );
    expect(plan.apply).toEqual({ clientAppearanceAccent: "green", clientWordWrap: true });
    expect(plan.patch).toEqual({
      migrateClientPreferences: { clientNotificationMode: "notifications" },
    });
  });

  it("publishes independent edits and resets, without echoing a peer edit", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      clientAppearanceAccent: "blue",
      clientWordWrap: false,
    } as const;
    const initial = planClientPreferenceSync(defaults, settings, new Map());
    const local = { ...defaults, ...initial.apply };
    const observed = planClientPreferenceSync(local, settings, initial.next);
    const edit = planClientPreferenceSync(
      { ...local, clientAppearanceAccent: "orange" },
      { ...settings, clientWordWrap: true },
      observed.next,
    );
    expect(edit.patch).toEqual({ clientAppearanceAccent: "orange" });
    expect(edit.apply).toEqual({ clientWordWrap: true });
    const settled = planClientPreferenceSync(
      { ...local, clientAppearanceAccent: "orange", ...edit.apply },
      { ...settings, clientAppearanceAccent: "orange", clientWordWrap: true },
      edit.next,
    );
    expect(settled.patch).toEqual({});
    expect(settled.apply).toEqual({});
  });

  it("keeps pending local values while the server snapshot is still stale", () => {
    const initial = planClientPreferenceSync(defaults, DEFAULT_SERVER_SETTINGS, new Map());
    const local = { ...defaults, clientAppearanceAccent: "teal" };
    const write = planClientPreferenceSync(local, DEFAULT_SERVER_SETTINGS, initial.next);
    const waiting = planClientPreferenceSync(local, DEFAULT_SERVER_SETTINGS, write.next);
    expect(waiting.patch).toEqual({});
    expect(waiting.apply).toEqual({});
    const acknowledged = planClientPreferenceSync(
      local,
      { ...DEFAULT_SERVER_SETTINGS, clientAppearanceAccent: "teal" },
      waiting.next,
    );
    const peer = planClientPreferenceSync(
      local,
      { ...DEFAULT_SERVER_SETTINGS, clientAppearanceAccent: "red" },
      acknowledged.next,
    );
    expect(peer.apply).toEqual({ clientAppearanceAccent: "red" });
  });

  it("does not publish stale cache values while a received application is delayed", () => {
    const shared = { ...DEFAULT_SERVER_SETTINGS, clientWordWrap: false };
    const first = planClientPreferenceSync(defaults, shared, new Map());
    const delayed = planClientPreferenceSync(defaults, shared, first.next);
    expect(delayed.patch).toEqual({});
    const applied = planClientPreferenceSync({ ...defaults, ...first.apply }, shared, delayed.next);
    expect(applied.patch).toEqual({});
    expect(applied.apply).toEqual({});
  });

  it("rolls back failed or silently ignored edits without retrying, then accepts a new explicit edit", () => {
    const shared = { ...DEFAULT_SERVER_SETTINGS, clientAppearanceAccent: "blue" as const };
    const first = planClientPreferenceSync(defaults, shared, new Map());
    const local = { ...defaults, ...first.apply, clientAppearanceAccent: "green" };
    const edit = planClientPreferenceSync(local, shared, first.next);
    for (const acknowledgement of [null, shared]) {
      const rejected = settleClientPreferenceWrite(edit.next, edit.patch, acknowledgement);
      expect(rejected.rejected).toBe(true);
      expect(rejected.apply).toEqual({ clientAppearanceAccent: "blue" });
      expect(planClientPreferenceSync(local, shared, rejected.next).patch).toEqual({});
      const restored = { ...local, ...rejected.apply };
      const settled = planClientPreferenceSync(restored, shared, rejected.next);
      expect(settled.patch).toEqual({});
      expect(
        planClientPreferenceSync(
          { ...restored, clientAppearanceAccent: "red" },
          shared,
          settled.next,
        ).patch,
      ).toEqual({ clientAppearanceAccent: "red" });
    }
  });

  it("reports unsupported legacy migration without repeatedly sending it", () => {
    const local = { ...defaults, clientAppearanceAccent: "blue" };
    const migrate = planClientPreferenceSync(local, DEFAULT_SERVER_SETTINGS, new Map());
    const ignored = settleClientPreferenceWrite(
      migrate.next,
      migrate.patch,
      DEFAULT_SERVER_SETTINGS,
    );
    expect(ignored.rejected).toBe(true);
    expect(planClientPreferenceSync(local, DEFAULT_SERVER_SETTINGS, ignored.next).patch).toEqual(
      {},
    );
  });

  it("an old write result cannot revert a newer local edit", () => {
    const first = planClientPreferenceSync(defaults, DEFAULT_SERVER_SETTINGS, new Map());
    const old = planClientPreferenceSync(
      { ...defaults, clientAppearanceAccent: "blue" },
      DEFAULT_SERVER_SETTINGS,
      first.next,
    );
    const newer = planClientPreferenceSync(
      { ...defaults, clientAppearanceAccent: "green" },
      DEFAULT_SERVER_SETTINGS,
      old.next,
    );
    const stale = settleClientPreferenceWrite(newer.next, old.patch, null);
    expect(stale.apply).toEqual({});
    expect(stale.next).toEqual(newer.next);
    const repeated = planClientPreferenceSync(
      { ...defaults, clientAppearanceAccent: "blue" },
      DEFAULT_SERVER_SETTINGS,
      newer.next,
    );
    const oldSameValue = settleClientPreferenceWrite(repeated.next, old.patch, null, old.next);
    expect(oldSameValue.apply).toEqual({});
    expect(oldSameValue.next).toEqual(repeated.next);
  });

  it("keeps browser profiles and machine routing local while portable fields fan out", () => {
    expect(
      clientSettingsPatchFromPreferences({ clientWordWrap: false, clientAppearanceAccent: "blue" }),
    ).toEqual({ wordWrap: false });
    expect(Object.keys(defaults)).not.toContain("clientBrowserProfiles");
    expect(Object.keys(defaults)).not.toContain("clientLoadBalancingWeights");
    const split = splitSharedServerPatch({
      clientWordWrap: false,
      branchNamePrefix: "fix",
      projectsRoot: "/local",
      migrateClientPreferences: { clientAppearanceMode: "light" },
    });
    expect(split.sharedPatch).toEqual({
      clientWordWrap: false,
      branchNamePrefix: "fix",
      migrateClientPreferences: { clientAppearanceMode: "light" },
    });
    expect(split.localPatch).toEqual({ projectsRoot: "/local" });
  });
});

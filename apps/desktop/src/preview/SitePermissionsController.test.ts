import { describe, expect, it, vi } from "vite-plus/test";

import { SitePermissionsController } from "./SitePermissionsController.ts";
import {
  permissionOriginOf,
  SitePermissionStore,
  sitePermissionsForRequest,
} from "./SitePermissionStore.ts";

const PARTITION = "persist:cogenly-preview-aaa";
const OTHER_PROFILE = "persist:cogenly-preview-profile-bbb";
const INCOGNITO = "cogenly-preview-ephemeral-ccc";
const ORIGIN = "https://app.example.com";

const isPersistent = (partition: string) => partition.startsWith("persist:");

function makeStore(snapshot: unknown = null) {
  const onChange = vi.fn();
  return { store: new SitePermissionStore(snapshot, { isPersistent, onChange }), onChange };
}

function makeController(snapshot: unknown = null) {
  const { store, onChange } = makeStore(snapshot);
  let nextId = 0;
  const controller = new SitePermissionsController(store, () => `prompt-${(nextId += 1)}`);
  const prompts: Array<{ webContentsId: number; promptId: string | null }> = [];
  controller.onPromptChange(({ webContentsId, prompt }) =>
    prompts.push({ webContentsId, promptId: prompt?.id ?? null }),
  );
  return { controller, store, onChange, prompts };
}

const ask = (
  controller: SitePermissionsController,
  permissions: Parameters<SitePermissionsController["request"]>[0]["permissions"],
  overrides: Partial<Parameters<SitePermissionsController["request"]>[0]> = {},
) => {
  const respond = vi.fn();
  controller.request({
    partition: PARTITION,
    origin: ORIGIN,
    permissions,
    webContentsId: 1,
    respond,
    ...overrides,
  });
  return respond;
};

describe("sitePermissionsForRequest", () => {
  it("splits media into camera and microphone by what the page asked for", () => {
    expect(sitePermissionsForRequest("media", ["video"])).toEqual(["camera"]);
    expect(sitePermissionsForRequest("media", ["audio"])).toEqual(["microphone"]);
    expect(sitePermissionsForRequest("media", ["video", "audio"])).toEqual([
      "camera",
      "microphone",
    ]);
    // A request that does not say what it wants is asked about both.
    expect(sitePermissionsForRequest("media")).toEqual(["camera", "microphone"]);
  });

  it("maps the other promptable permissions and refuses the rest", () => {
    expect(sitePermissionsForRequest("geolocation")).toEqual(["geolocation"]);
    expect(sitePermissionsForRequest("notifications")).toEqual(["notifications"]);
    expect(sitePermissionsForRequest("clipboard-read")).toEqual(["clipboard-read"]);
    expect(sitePermissionsForRequest("midiSysex")).toEqual(["midi"]);
    expect(sitePermissionsForRequest("local-fonts")).toBeNull();
    expect(sitePermissionsForRequest("usb")).toBeNull();
  });
});

describe("permissionOriginOf", () => {
  it("keys web pages by origin and ignores everything else", () => {
    expect(permissionOriginOf("https://app.example.com/photos/smile?x=1")).toBe(ORIGIN);
    expect(permissionOriginOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(permissionOriginOf("file:///tmp/a.html")).toBeNull();
    expect(permissionOriginOf("about:blank")).toBeNull();
    expect(permissionOriginOf(undefined)).toBeNull();
  });
});

describe("SitePermissionStore", () => {
  it("remembers a decision per origin and per profile", () => {
    const { store } = makeStore();
    store.change(PARTITION, ORIGIN, "camera", "allow", "user");
    expect(store.evaluate(PARTITION, ORIGIN, ["camera"])).toEqual({ kind: "allow" });
    expect(store.evaluate(PARTITION, "https://other.example.com", ["camera"]).kind).toBe("ask");
    expect(store.evaluate(OTHER_PROFILE, ORIGIN, ["camera"]).kind).toBe("ask");
  });

  it("decides camera and microphone separately", () => {
    const { store } = makeStore();
    store.change(PARTITION, ORIGIN, "microphone", "allow", "user");
    expect(store.evaluate(PARTITION, ORIGIN, ["camera", "microphone"])).toEqual({
      kind: "ask",
      undecided: ["camera"],
    });
    store.change(PARTITION, ORIGIN, "camera", "block", "user");
    // One Block blocks the whole request.
    expect(store.evaluate(PARTITION, ORIGIN, ["camera", "microphone"])).toEqual({ kind: "block" });
  });

  it("moves between Allow, Block and Ask", () => {
    const { store } = makeStore();
    store.change(PARTITION, ORIGIN, "geolocation", "allow", "user");
    store.change(PARTITION, ORIGIN, "geolocation", "block", "user");
    expect(store.evaluate(PARTITION, ORIGIN, ["geolocation"])).toEqual({ kind: "block" });
    store.change(PARTITION, ORIGIN, "geolocation", "ask", "user");
    expect(store.evaluate(PARTITION, ORIGIN, ["geolocation"]).kind).toBe("ask");
    expect(store.snapshot().partitions).toEqual({});
  });

  it("lets an agent decide what the person has not, but never lift their Block", () => {
    const { store } = makeStore();
    expect(store.change(PARTITION, ORIGIN, "camera", "allow", "agent")).toEqual({ ok: true });
    store.change(PARTITION, ORIGIN, "microphone", "block", "user");
    expect(store.change(PARTITION, ORIGIN, "microphone", "allow", "agent")).toEqual({
      ok: false,
      reason: "user-blocked",
    });
    expect(store.change(PARTITION, ORIGIN, "microphone", "ask", "agent")).toEqual({
      ok: false,
      reason: "user-blocked",
    });
    expect(store.get(PARTITION, ORIGIN, "microphone")).toEqual({
      setting: "block",
      decidedBy: "user",
    });
    // The person can still lift it.
    expect(store.change(PARTITION, ORIGIN, "microphone", "allow", "user")).toEqual({ ok: true });
  });

  it("lets an agent tighten a site the person allowed, and undo its own Block", () => {
    const { store } = makeStore();
    store.change(PARTITION, ORIGIN, "camera", "allow", "user");
    expect(store.change(PARTITION, ORIGIN, "camera", "block", "agent")).toEqual({ ok: true });
    expect(store.get(PARTITION, ORIGIN, "camera")).toEqual({
      setting: "block",
      decidedBy: "agent",
    });
    // The Block is the agent's own now, not the person's.
    expect(store.change(PARTITION, ORIGIN, "camera", "ask", "agent")).toEqual({ ok: true });
    expect(store.get(PARTITION, ORIGIN, "camera")).toBeUndefined();
  });

  it("persists decisions, but not incognito ones", () => {
    const { store, onChange } = makeStore();
    store.change(PARTITION, ORIGIN, "camera", "allow", "user");
    store.change(INCOGNITO, ORIGIN, "camera", "allow", "user");
    expect(onChange).toHaveBeenCalledTimes(1);
    const snapshot = store.snapshot();
    expect(Object.keys(snapshot.partitions)).toEqual([PARTITION]);

    const { store: reloaded, onChange: reloadedChange } = makeStore(snapshot);
    expect(reloaded.evaluate(PARTITION, ORIGIN, ["camera"])).toEqual({ kind: "allow" });
    expect(reloaded.get(PARTITION, ORIGIN, "camera")?.decidedBy).toBe("user");
    expect(reloadedChange).not.toHaveBeenCalled();
  });

  it("drops malformed saved data instead of throwing", () => {
    const { store } = makeStore({
      version: 1,
      partitions: {
        [PARTITION]: {
          [ORIGIN]: {
            camera: { setting: "allow", decidedBy: "user" },
            microphone: { setting: "maybe", decidedBy: "user" },
            teleport: { setting: "allow", decidedBy: "user" },
            geolocation: null,
          },
          "not an origin": { camera: { setting: "allow", decidedBy: "user" } },
        },
        broken: 7,
      },
    });
    expect(store.get(PARTITION, ORIGIN, "camera")?.setting).toBe("allow");
    expect(store.get(PARTITION, ORIGIN, "microphone")).toBeUndefined();
    expect(store.get(PARTITION, "not an origin", "camera")).toBeUndefined();
    expect(() => makeStore("garbage")).not.toThrow();
  });

  it("lists every supported permission with Ask as the default", () => {
    const { store } = makeStore();
    store.change(PARTITION, ORIGIN, "camera", "allow", "user");
    const entries = store.entries(PARTITION, ORIGIN);
    expect(entries.find((entry) => entry.permission === "camera")).toEqual({
      permission: "camera",
      setting: "allow",
      decidedBy: "user",
    });
    expect(entries.find((entry) => entry.permission === "microphone")).toEqual({
      permission: "microphone",
      setting: "ask",
    });
    expect(store.entries(PARTITION, null).every((entry) => entry.setting === "ask")).toBe(true);
  });
});

describe("SitePermissionsController", () => {
  it("answers at once when the origin is already decided", () => {
    const { controller } = makeController();
    controller.change(PARTITION, ORIGIN, "camera", "allow", "user");
    expect(ask(controller, ["camera"])).toHaveBeenCalledExactlyOnceWith(true);
    controller.change(PARTITION, ORIGIN, "camera", "block", "user");
    expect(ask(controller, ["camera"])).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("holds an undecided request as a prompt until the person answers", () => {
    const { controller, prompts } = makeController();
    const respond = ask(controller, ["camera"]);
    expect(respond).not.toHaveBeenCalled();
    expect(controller.promptFor(1)).toEqual({
      id: "prompt-1",
      origin: ORIGIN,
      permissions: ["camera"],
    });
    expect(controller.promptFor(2)).toBeNull();
    expect(prompts).toEqual([{ webContentsId: 1, promptId: "prompt-1" }]);

    controller.answer(1, "prompt-1", "allow");
    expect(respond).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.promptFor(1)).toBeNull();
    // Remembered: the next ask is not a prompt.
    expect(ask(controller, ["camera"])).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("denies and remembers on Block", () => {
    const { controller } = makeController();
    const respond = ask(controller, ["microphone"]);
    controller.answer(1, "prompt-1", "block");
    expect(respond).toHaveBeenCalledExactlyOnceWith(false);
    expect(ask(controller, ["microphone"])).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("denies a dismissed prompt once without remembering", () => {
    const { controller, store } = makeController();
    const respond = ask(controller, ["geolocation"]);
    controller.answer(1, "prompt-1", "dismiss");
    expect(respond).toHaveBeenCalledExactlyOnceWith(false);
    expect(store.get(PARTITION, ORIGIN, "geolocation")).toBeUndefined();
    // Asking again prompts again.
    ask(controller, ["geolocation"]);
    expect(controller.promptFor(1)?.id).toBe("prompt-2");
  });

  it("ignores an answer for a prompt that is not showing on that tab", () => {
    const { controller } = makeController();
    const respond = ask(controller, ["camera"]);
    controller.answer(2, "prompt-1", "allow");
    controller.answer(1, "stale", "allow");
    expect(respond).not.toHaveBeenCalled();
  });

  it("asks only about what is undecided when a request mixes decided and new permissions", () => {
    const { controller } = makeController();
    controller.change(PARTITION, ORIGIN, "microphone", "allow", "user");
    const respond = ask(controller, ["camera", "microphone"]);
    expect(controller.promptFor(1)?.permissions).toEqual(["camera"]);
    controller.answer(1, "prompt-1", "allow");
    expect(respond).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("settles every waiting request for the origin with one answer", () => {
    const { controller } = makeController();
    const first = ask(controller, ["camera"]);
    const second = ask(controller, ["camera"]);
    const otherTab = ask(controller, ["camera"], { webContentsId: 2 });
    controller.answer(1, "prompt-1", "allow");
    expect(first).toHaveBeenCalledExactlyOnceWith(true);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
    expect(otherTab).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("lets an agent's decision answer a waiting prompt", () => {
    const { controller, prompts } = makeController();
    const respond = ask(controller, ["camera"]);
    expect(controller.change(PARTITION, ORIGIN, "camera", "allow", "agent")).toEqual({ ok: true });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true);
    expect(prompts.at(-1)).toEqual({ webContentsId: 1, promptId: null });
  });

  it("keeps an agent from overriding a Block the person chose", () => {
    const { controller } = makeController();
    controller.change(PARTITION, ORIGIN, "camera", "block", "user");
    expect(controller.change(PARTITION, ORIGIN, "camera", "allow", "agent")).toEqual({
      ok: false,
      reason: "user-blocked",
    });
    expect(ask(controller, ["camera"])).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps profiles apart", () => {
    const { controller } = makeController();
    controller.change(PARTITION, ORIGIN, "camera", "allow", "user");
    const other = ask(controller, ["camera"], { partition: OTHER_PROFILE });
    expect(other).not.toHaveBeenCalled();
  });

  it("denies a tab's waiting requests when it leaves the origin or closes", () => {
    const { controller, prompts } = makeController();
    const asked = ask(controller, ["camera"]);
    const sameOrigin = ask(controller, ["microphone"]);
    controller.cancel(1, ORIGIN);
    expect(asked).not.toHaveBeenCalled();
    controller.cancel(1, "https://elsewhere.example.com");
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
    expect(sameOrigin).toHaveBeenCalledExactlyOnceWith(false);
    expect(controller.promptFor(1)).toBeNull();
    expect(prompts.at(-1)).toEqual({ webContentsId: 1, promptId: null });
  });

  it("denies a page that stacks prompts without waiting", () => {
    const { controller } = makeController();
    const responses = Array.from({ length: 9 }, () => ask(controller, ["camera"]));
    expect(responses.slice(0, 8).every((respond) => respond.mock.calls.length === 0)).toBe(true);
    expect(responses[8]).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("checks synchronously without prompting", () => {
    const { controller } = makeController();
    expect(controller.check(PARTITION, ORIGIN, ["camera"], "all")).toBe(false);
    controller.change(PARTITION, ORIGIN, "camera", "allow", "user");
    expect(controller.check(PARTITION, ORIGIN, ["camera"], "all")).toBe(true);
    // An unspecific media check passes when either device is allowed.
    expect(controller.check(PARTITION, ORIGIN, ["camera", "microphone"], "any")).toBe(true);
    expect(controller.check(PARTITION, ORIGIN, ["camera", "microphone"], "all")).toBe(false);
    expect(controller.promptFor(1)).toBeNull();
  });

  it("reports a tab's state for the origin it shows", () => {
    const { controller } = makeController();
    controller.change(PARTITION, ORIGIN, "camera", "allow", "user");
    ask(controller, ["microphone"]);
    const state = controller.state(PARTITION, 1, `${ORIGIN}/photos/smile`);
    expect(state.origin).toBe(ORIGIN);
    expect(state.entries.find((entry) => entry.permission === "camera")?.setting).toBe("allow");
    expect(state.prompt?.permissions).toEqual(["microphone"]);
    expect(controller.state(PARTITION, 1, "about:blank").origin).toBeNull();
  });
});

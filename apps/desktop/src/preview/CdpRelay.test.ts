import { describe, expect, it } from "@effect/vitest";
import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

/** CDP domains are enabled per real session, as in Chromium. The manager stays attached. */
function pageTarget() {
  let sequence = 0;
  const enabled = new Set<string>(["manager"]);
  const sessions = new Set<string>();
  const sent: Array<{ method: string; sessionId: string | undefined }> = [];
  let event = (_method: string, _params: unknown, _sessionId: string | undefined) => {};
  const target: CdpRelayTarget = {
    targetId: async () => "signed-in-page",
    url: () => "https://example.test/setup",
    title: () => "Signed in",
    userAgent: () => "Chrome",
    setDownloadDirectory: () => {},
    send: async (method, params, sessionId) => {
      sent.push({ method, sessionId });
      if (method === "Target.attachToTarget") {
        const id = `real-${++sequence}`;
        sessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.detachFromTarget") {
        sessions.delete(String(params.sessionId));
        return {};
      }
      const id = sessionId ?? "manager";
      if (method === "Runtime.enable" && !enabled.has(id)) {
        enabled.add(id);
        event(
          "Runtime.executionContextCreated",
          { context: { id: sequence, name: "", origin: "https://example.test" } },
          sessionId,
        );
      }
      if (method === "Runtime.evaluate")
        return { result: { type: "string", value: "signed-in-session" } };
      if (method === "Accessibility.getFullAXTree")
        return { nodes: [{ role: { value: "RootWebArea" }, name: { value: "Signed in" } }] };
      return {};
    },
  };
  return {
    target,
    sessions,
    sent,
    listen: (listener: typeof event) => {
      event = listener;
    },
  };
}

function client(page: ReturnType<typeof pageTarget>) {
  let sequence = 0;
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  const events: Array<Record<string, unknown>> = [];
  const relay = createCdpRelayConnection(page.target, (raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (typeof message.id === "number") waiters.get(message.id)?.(message);
    else events.push(message);
  });
  page.listen(relay.event);
  const command = (method: string, sessionId?: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++sequence;
      waiters.set(id, resolve);
      relay.receive(JSON.stringify({ id, method, sessionId, params }));
    });
  return { relay, command, events };
}

it("reconnects repeatedly to the same signed-in target", async () => {
  const page = pageTarget();
  for (let attempt = 0; attempt < 3; attempt++) {
    const connection = client(page);
    await connection.command("Target.setAutoAttach");
    await connection.command("Runtime.enable", "t3-preview-page");
    expect(
      connection.events.some((event) => event.method === "Runtime.executionContextCreated"),
    ).toBe(true);
    expect(
      await connection.command("Runtime.evaluate", "t3-preview-page", {
        expression: "sessionStorage.login",
      }),
    ).toMatchObject({ result: { result: { value: "signed-in-session" } } });
    expect(
      await connection.command("Accessibility.getFullAXTree", "t3-preview-page"),
    ).toMatchObject({ result: { nodes: [{ name: { value: "Signed in" } }] } });
    await connection.relay.close();
    expect(page.sessions.size).toBe(0);
  }
  expect(
    page.sent.some(({ method }) =>
      ["Page.reload", "Page.navigate", "Target.closeTarget", "Runtime.disable"].includes(method),
    ),
  ).toBe(false);
});

describe("independent CDP sessions", () => {
  it("keeps page events separate and preserves child iframe sessions", async () => {
    const page = pageTarget();
    const connection = client(page);
    await connection.command("Target.setAutoAttach");
    const attached = await connection.command("Target.attachToTarget", undefined, {
      targetId: "signed-in-page",
    });
    const extra = (attached.result as { sessionId: string }).sessionId;
    await connection.command("Runtime.enable", extra);
    const contextEvents = connection.events.filter(
      (event) => event.method === "Runtime.executionContextCreated",
    );
    expect(contextEvents.map((event) => event.sessionId)).toEqual([extra]);
    connection.relay.event("Runtime.executionContextCreated", {}, undefined);
    expect(
      connection.events.filter((event) => event.method === "Runtime.executionContextCreated"),
    ).toHaveLength(1);
    await connection.command("Runtime.runIfWaitingForDebugger", "iframe-session");
    expect(page.sent.at(-1)).toEqual({
      method: "Runtime.runIfWaitingForDebugger",
      sessionId: "iframe-session",
    });
    await connection.command("Input.insertText", "t3-preview-page", { text: "text" });
    expect(page.sent.at(-1)).toEqual({ method: "Input.insertText", sessionId: undefined });
    await connection.relay.close();
  });
});

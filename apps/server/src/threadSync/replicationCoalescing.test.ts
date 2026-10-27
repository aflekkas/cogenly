import { describe, expect, it } from "@effect/vitest";

import {
  type ReplicationEventSummary,
  replicationEntityKey,
  supersededReplicationEvents,
} from "./replicationCoalescing.ts";

let next = 0;
const event = (
  type: string,
  entityId: string | null,
  options: {
    readonly threadId?: string;
    readonly fieldTypes?: Record<string, string>;
    readonly retained?: boolean;
  } = {},
): ReplicationEventSummary => ({
  sequence: ++next,
  threadId: options.threadId ?? "thread:a",
  type,
  entityId,
  fieldTypes: options.fieldTypes ?? {},
  retained: options.retained ?? false,
});

const kept = (events: ReadonlyArray<ReplicationEventSummary>) => {
  const superseded = supersededReplicationEvents(events);
  return events.filter((item) => !superseded.has(item.sequence));
};

describe("supersededReplicationEvents", () => {
  it("keeps each entity's first and last update and drops those between", () => {
    const first = event("turn-item.updated", "item:1");
    const middle = [event("turn-item.updated", "item:1"), event("turn-item.updated", "item:1")];
    const last = event("turn-item.updated", "item:1");
    expect(kept([first, ...middle, last])).toEqual([first, last]);
  });

  it("keeps the order of every remaining event across entities", () => {
    const events = [
      event("run.created", "run:1"),
      event("node.updated", "node:1"),
      event("turn-item.updated", "item:1"),
      event("node.updated", "node:1"),
      event("turn-item.updated", "item:2"),
      event("turn-item.updated", "item:1"),
      event("node.updated", "node:1"),
      event("turn-item.updated", "item:1"),
      event("run.updated", "run:1"),
    ];
    // First sights stay in place and in order; the terminal run update stays last.
    expect(kept(events).map((item) => item.sequence)).toEqual(
      [0, 1, 2, 4, 6, 7, 8].map((at) => events[at]!.sequence),
    );
  });

  it("never drops a type whose projection is not a whole-payload upsert", () => {
    const events = [
      ...Array.from({ length: 4 }, () => event("provider-thread.updated", "pt:1")),
      ...Array.from({ length: 4 }, () => event("runtime-request.updated", "request:1")),
      ...Array.from({ length: 4 }, () => event("thread.metadata-updated", "thread:a")),
      ...Array.from({ length: 4 }, () => event("checkpoint.captured", "checkpoint:1")),
    ];
    expect(kept(events)).toEqual(events);
  });

  it("keys entities by thread and type as well as id", () => {
    const events = [
      event("message.updated", "same"),
      event("message.updated", "same", { threadId: "thread:b" }),
      event("node.updated", "same"),
      event("message.updated", "same", { threadId: "thread:b" }),
      event("node.updated", "same"),
      event("message.updated", "same"),
    ];
    expect(kept(events)).toEqual(events);
  });

  it("keeps an update that supplies a field the latest snapshot omits", () => {
    const usage = { tokenUsage: "object" };
    const first = event("provider-turn.updated", "turn:1");
    const reported = event("provider-turn.updated", "turn:1", { fieldTypes: usage });
    const streamed = event("provider-turn.updated", "turn:1");
    const older = event("provider-turn.updated", "turn:1", { fieldTypes: usage });
    const last = event("provider-turn.updated", "turn:1");
    // Only the latest usage report shows once the last update omits it.
    expect(kept([first, older, reported, streamed, last])).toEqual([first, reported, last]);
  });

  it("drops earlier field values once a later kept update sets them", () => {
    const first = event("subagent.updated", "subagent:1");
    const delivered = event("subagent.updated", "subagent:1", {
      fieldTypes: { completionDelivery: "object" },
    });
    const last = event("subagent.updated", "subagent:1", {
      fieldTypes: { completionDelivery: "object" },
    });
    expect(kept([first, delivered, last])).toEqual([first, last]);
  });

  it("treats a JSON null as carried but not as covering", () => {
    const first = event("run.updated", "run:1");
    const cleared = event("run.updated", "run:1", { fieldTypes: { delegatedCompletion: "null" } });
    const last = event("run.updated", "run:1", { fieldTypes: { delegatedCompletion: "null" } });
    expect(kept([first, cleared, last])).toEqual([first, cleared, last]);
  });

  it("keeps updates a newer build sent with fields this one cannot read", () => {
    const events = [
      event("node.updated", "node:1"),
      event("node.updated", "node:1", { retained: true }),
      event("node.updated", "node:1"),
      event("node.updated", "node:1"),
    ];
    expect(kept(events)).toEqual([events[0], events[1], events[3]]);
  });

  it("drops the first update of an entity the peer has already seen", () => {
    const continued = [
      event("provider-turn.updated", "turn:1"),
      event("provider-turn.updated", "turn:1"),
    ];
    const fresh = [event("node.updated", "node:1"), event("node.updated", "node:1")];
    const seen = new Set([replicationEntityKey("thread:a", "provider-turn.updated", "turn:1")]);
    const superseded = supersededReplicationEvents([...continued, ...fresh], seen);
    expect([...superseded]).toEqual([continued[0]!.sequence]);
  });

  it("ignores events without an entity id", () => {
    const events = Array.from({ length: 4 }, () => event("node.updated", null));
    expect(kept(events)).toEqual(events);
  });
});

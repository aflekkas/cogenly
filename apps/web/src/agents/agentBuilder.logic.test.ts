import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  defaultAgentPermissions,
  type AgentBuilderProposal,
  type OrchestrationV2TurnItem,
} from "@cogenly/contracts";
import {
  canCreateProposal,
  parseProposal,
  parseScheduleSpec,
  parseTimeOfDay,
  proposalFromMessages,
  proposalFromTurnItems,
  proposalProjectFolderId,
  proposalToDraft,
  proposalTriggers,
  scheduleInWords,
  stripProposal,
  structuredProposal,
} from "./agentBuilder.logic";

const block = (lines: string) => "Here you go.\n\n```agent\n" + lines + "\n```";

describe("builder messages", () => {
  it("strips a closed or still-streaming proposal block from the prose", () => {
    expect(stripProposal(block("name: Shopper"))).toBe("Here you go.");
    expect(stripProposal("Sure!\n\n```agent\nname: Sho")).toBe("Sure!");
    expect(stripProposal("Plain reply")).toBe("Plain reply");
  });
});

const structured = (overrides: Partial<AgentBuilderProposal> = {}): AgentBuilderProposal => ({
  name: "Halloween Shopper",
  face: { shape: "nuage", color: "orange", expression: "excite" },
  responsibility: "Find Halloween shirts I'd actually wear.",
  instructions: "Keep a shortlist; ask before buying.",
  triggers: [
    {
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      title: "Morning picks",
      prompt: "Look for new shirts and post the best three.",
    },
  ],
  needs: ["Web browsing", "Amazon"],
  permissions: { send: true, create_pr: true },
  ...overrides,
});

const proposalItem = (proposal: AgentBuilderProposal): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("agent-proposal:thread-1"),
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: proposal.name,
  type: "agent_proposal",
  proposal,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-20T00:00:00.000Z"),
});

describe("structuredProposal", () => {
  it("reads the whole call as a complete card", () => {
    expect(structuredProposal(structured())).toEqual({
      name: "Halloween Shopper",
      face: { shape: "nuage", color: "orange", expression: "excite" },
      responsibility: "Find Halloween shirts I'd actually wear.",
      instructions: "Keep a shortlist; ask before buying.",
      triggers: [
        {
          when: "Every day at 9am",
          title: "Morning picks",
          prompt: "Look for new shirts and post the best three.",
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
        },
      ],
      needs: ["Web browsing", "Amazon"],
      permissions: ["send", "create_pr"],
      complete: true,
    });
  });

  it("drops unknown face parts and default grants, and fills a bare webhook", () => {
    const proposal = structuredProposal(
      structured({
        face: { shape: "nuage", color: "chartreuse", expression: "excite" },
        permissions: { send: true, execute: true, merge: false },
        triggers: [{ schedule: { type: "webhook" }, title: "Hook", prompt: "Run when called." }],
      }),
    );
    expect(proposal.face).toEqual({ shape: "nuage", expression: "excite" });
    expect(proposal.permissions).toEqual(["send"]);
    expect(proposal.triggers).toEqual([
      {
        when: "When its webhook is called",
        title: "Hook",
        prompt: "Run when called.",
        schedule: { type: "webhook", signature: null },
      },
    ]);
  });

  it("takes the newest proposal item in the thread", () => {
    const items = [proposalItem(structured()), proposalItem(structured({ name: "Second" }))];
    expect(proposalFromTurnItems(items)?.name).toBe("Second");
    expect(proposalFromTurnItems([])).toBeNull();
  });
});

describe("parseProposal", () => {
  it("reads every field and ignores unknown face parts", () => {
    const proposal = parseProposal(
      block(
        [
          "name: Halloween Shopper",
          "face: nuage orange excite sparkly",
          "responsibility: Find Halloween shirts I'd actually wear.",
          "instructions: Keep a shortlist; ask before buying.",
          "trigger: daily at 9am :: Morning picks :: Look for new shirts and post the best three.",
          "trigger: when pr checks fail :: Checks :: Tell me.",
          "needs: Web browsing, Amazon",
          "permissions: send, create pr, read",
        ].join("\n"),
      ),
    );
    expect(proposal).toMatchObject({
      name: "Halloween Shopper",
      face: { shape: "nuage", color: "orange", expression: "excite" },
      responsibility: "Find Halloween shirts I'd actually wear.",
      instructions: "Keep a shortlist; ask before buying.",
      needs: ["Web browsing", "Amazon"],
      permissions: ["send", "create_pr"],
      complete: true,
    });
    expect(proposal?.triggers).toEqual([
      {
        when: "daily at 9am",
        title: "Morning picks",
        prompt: "Look for new shirts and post the best three.",
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      },
      {
        when: "when pr checks fail",
        title: "Checks",
        prompt: "Tell me.",
        schedule: { type: "event", event: "pr.checks_failed" },
      },
    ]);
  });

  it("assembles while streaming: finished lines count, the partial one waits", () => {
    const streaming = parseProposal("On it.\n\n```agent\nname: PR Digest\nface: nuage bl");
    expect(streaming).toMatchObject({ name: "PR Digest", complete: false });
    expect(streaming?.face).toBeUndefined();
    const more = parseProposal("On it.\n\n```agent\nname: PR Digest\nface: nuage bleu\nrespo");
    expect(more?.face).toEqual({ shape: "nuage", color: "bleu" });
  });

  it("returns null without a block, and 'none' empties a list", () => {
    expect(parseProposal("What should it watch?")).toBeNull();
    expect(parseProposal(block("needs: none\npermissions: none"))).toMatchObject({
      needs: [],
      permissions: [],
    });
  });

  it("takes the newest proposal in the conversation", () => {
    const proposal = proposalFromMessages([
      { role: "assistant", text: block("name: First") },
      { role: "user", text: "call it Second" },
      { role: "assistant", text: block("name: Second") },
      { role: "assistant", text: "Anything else?" },
    ]);
    expect(proposal?.name).toBe("Second");
    expect(proposalFromMessages([{ role: "user", text: "hi" }])).toBeNull();
  });
});

describe("schedule grammar", () => {
  it("parses times of day", () => {
    expect(parseTimeOfDay("9am")).toBe("09:00");
    expect(parseTimeOfDay("9:30 PM")).toBe("21:30");
    expect(parseTimeOfDay("12am")).toBe("00:00");
    expect(parseTimeOfDay("17:05")).toBe("17:05");
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("soon")).toBeNull();
  });

  it("parses intervals, fixed times, weekday sets, events and webhooks", () => {
    expect(parseScheduleSpec("every 30 minutes")).toEqual({ type: "interval", everyMs: 1_800_000 });
    expect(parseScheduleSpec("every hour")).toEqual({ type: "interval", everyMs: 3_600_000 });
    expect(parseScheduleSpec("every 2 days")).toEqual({ type: "interval", everyMs: 172_800_000 });
    expect(parseScheduleSpec("daily at 09:00")).toEqual({ type: "fixed_time", timeOfDay: "09:00" });
    expect(parseScheduleSpec("weekdays at 9am")).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(parseScheduleSpec("weekends at 6pm")).toEqual({
      type: "fixed_time",
      timeOfDay: "18:00",
      weekdays: [0, 6],
    });
    expect(parseScheduleSpec("on Mon, Wed and Friday at 18:00")).toEqual({
      type: "fixed_time",
      timeOfDay: "18:00",
      weekdays: [1, 3, 5],
    });
    expect(parseScheduleSpec("when pr.merged")).toEqual({ type: "event", event: "pr.merged" });
    expect(parseScheduleSpec("when a PR opens")).toEqual({ type: "event", event: "pr.updated" });
    expect(parseScheduleSpec("when work finishes")).toEqual({
      type: "event",
      event: "work.completed",
    });
    expect(parseScheduleSpec("webhook")).toEqual({ type: "webhook", signature: null });
    expect(parseScheduleSpec("whenever I feel like it")).toBeNull();
    expect(parseScheduleSpec("every 0 hours")).toBeNull();
  });

  it("says schedules in plain words", () => {
    expect(
      scheduleInWords({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("Every weekday at 9am");
    expect(scheduleInWords({ type: "fixed_time", timeOfDay: "18:30" })).toBe("Every day at 6:30pm");
    expect(scheduleInWords({ type: "fixed_time", timeOfDay: "12:00", weekdays: [1, 3] })).toBe(
      "Mon, Wed at 12pm",
    );
    expect(scheduleInWords({ type: "interval", everyMs: 7_200_000 })).toBe("Every 2 hours");
    expect(scheduleInWords({ type: "interval", everyMs: 60_000 })).toBe("Every minute");
    expect(scheduleInWords({ type: "event", event: "pr.checks_failed" })).toBe(
      "When PR checks fail",
    );
    expect(scheduleInWords({ type: "webhook" })).toBe("When its webhook is called");
  });
});

describe("creating from a proposal", () => {
  const context = {
    seed: "seed-1",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
    projectId: ProjectId.make("project-1"),
  };

  it("needs a name and a responsibility", () => {
    expect(canCreateProposal(null)).toBe(false);
    expect(canCreateProposal(parseProposal(block("name: Only")))).toBe(false);
    expect(canCreateProposal(parseProposal(block("name: Both\nresponsibility: Do it.")))).toBe(
      true,
    );
  });

  it("turns the proposal into the create payload with defaults and granted permissions", () => {
    const proposal = parseProposal(
      block(
        "name:  Halloween Shopper \nface: goutte violet curieux\nresponsibility: Shop.\npermissions: send",
      ),
    )!;
    expect(proposalToDraft({ ...proposal, name: proposal.name! }, context)).toEqual({
      name: "Halloween Shopper",
      avatar: { seed: "seed-1", shape: "goutte", color: "violet", expression: "curieux" },
      responsibility: "Shop.",
      instructions: "",
      modelSelection: context.modelSelection,
      runtimeMode: "full-access",
      projectId: context.projectId,
      dailyRunCap: 24,
      permissions: { ...defaultAgentPermissions, send: true },
    });
  });

  it("keeps only triggers that parsed, filling title and prompt", () => {
    const proposal = parseProposal(
      block(
        [
          "responsibility: Watch PRs.",
          "trigger: weekdays at 9am :: :: ",
          "trigger: whenever :: Vague :: Do something",
        ].join("\n"),
      ),
    )!;
    expect(proposalTriggers(proposal)).toEqual([
      {
        title: "Every weekday at 9am",
        prompt: "Watch PRs.",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
        enabled: true,
      },
    ]);
  });

  it("files the agent in the card's pick, else the builder's named folder, else its own", () => {
    const web = ProjectLabelId.make("web");
    const ops = ProjectLabelId.make("ops");
    const gone = ProjectLabelId.make("gone");
    const exists = (id: ProjectLabelId) => id === web || id === ops;
    const pick = (input: {
      chosen?: ProjectLabelId | null;
      proposed?: ProjectLabelId;
      builder?: ProjectLabelId | null;
    }) =>
      proposalProjectFolderId({
        chosen: input.chosen,
        proposed: input.proposed,
        builder: input.builder ?? null,
        exists,
      });
    expect(pick({ chosen: ops, proposed: web, builder: web })).toBe(ops);
    // No project on the card wins over everything else.
    expect(pick({ chosen: null, proposed: web, builder: web })).toBeNull();
    expect(pick({ proposed: web, builder: ops })).toBe(web);
    expect(pick({ proposed: gone, builder: ops })).toBe(ops);
    expect(pick({})).toBeNull();
    const proposal = parseProposal(block("name: Filed\nresponsibility: Do it."))!;
    expect(
      proposalToDraft({ ...proposal, name: "Filed" }, { ...context, projectFolderId: web })
        .projectFolderId,
    ).toBe(web);
  });
});

/**
 * The agent builder: a conversation with the owner's default model that ends in an
 * agent. The model talks in prose and keeps the live proposal in `propose_agent`
 * calls, which the client reads as the thread's `agent_proposal` turn item. A
 * fenced `agent` block of `key: value` lines stays as the fallback the card
 * assembles line by line while a reply streams. Everything here is pure: the
 * structured read, the fallback parser, the schedule grammar, and the turn
 * from a proposal into the create payload.
 */
import {
  defaultAgentPermissions,
  type AgentAvatar,
  type AgentBuilderProposal,
  type AgentEventKind,
  type AgentPermissions,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProjectLabelId,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import { EXPRESSIONS as AGENT_FACE_EXPRESSIONS } from "~/components/agents/face/engine/expressions";
import {
  COLORS as AGENT_FACE_COLORS,
  SHAPES as AGENT_FACE_SHAPES,
} from "~/components/agents/face/engine/skins";
import { EVENT_TRIGGER_LABEL } from "./agentWorkspace.logic";
import type { AgentDraft, AgentTrigger } from "./agents.types";

export const BUILDER_EXAMPLES: ReadonlyArray<string> = [
  "Watch my GitHub PRs and summarize them every morning",
  "Be my Halloween shirt shopper",
  "Keep track of what I owe clients and follow up",
];

const SHAPE_IDS = new Set<string>(AGENT_FACE_SHAPES.map((shape) => shape.id));
const COLOR_IDS = new Set<string>(AGENT_FACE_COLORS.map((color) => color.id));
const EXPRESSION_IDS = new Set<string>(AGENT_FACE_EXPRESSIONS.map((expression) => expression.id));
const EVENT_KINDS = new Set<string>(Object.keys(EVENT_TRIGGER_LABEL));
const GRANTABLE = new Set<keyof AgentPermissions>([
  "send",
  "create_pr",
  "merge",
  "deploy",
  "delete",
]);

export interface AgentProposalTrigger {
  /** The builder's own words for when it runs, kept for the card when they don't parse. */
  when: string;
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule | null;
}
export interface AgentProposal {
  name?: string;
  face?: Pick<AgentAvatar, "shape" | "color" | "expression">;
  responsibility?: string;
  instructions?: string;
  triggers: ReadonlyArray<AgentProposalTrigger>;
  /** Tools or integrations in the builder's words; informational only. */
  needs: ReadonlyArray<string>;
  /** High-impact grants the builder asked for on top of the defaults. */
  permissions: ReadonlyArray<keyof AgentPermissions>;
  /** The project folder the builder filed the agent in, if it named one. */
  projectFolderId?: ProjectLabelId;
  /** The block closed, so the builder finished this version. */
  complete: boolean;
}

const FENCE = "```agent";

/** The reply without its proposal block, closed or still streaming. */
export function stripProposal(text: string): string {
  const start = text.lastIndexOf(FENCE);
  if (start === -1) return text.trim();
  const end = text.indexOf("```", start + FENCE.length);
  const after = end === -1 ? "" : text.slice(end + 3);
  return `${text.slice(0, start)}${after}`.trim();
}

const EMPTY_PROPOSAL: AgentProposal = {
  triggers: [],
  needs: [],
  permissions: [],
  complete: false,
};

const list = (value: string) =>
  value.toLowerCase() === "none"
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

/**
 * The proposal in a reply. While the block streams, only its finished lines count,
 * so a field never shows half a value; the block is complete once its fence closes.
 */
export function parseProposal(text: string): AgentProposal | null {
  const start = text.lastIndexOf(FENCE);
  if (start === -1) return null;
  const bodyStart = start + FENCE.length;
  const end = text.indexOf("```", bodyStart);
  const body = end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end);
  const lines = body.split("\n");
  // Without a closing fence the last line may still be arriving.
  const settled = end === -1 ? lines.slice(0, -1) : lines;
  const proposal: {
    -readonly [K in keyof AgentProposal]: AgentProposal[K];
  } = { ...EMPTY_PROPOSAL, complete: end !== -1 };
  const triggers: AgentProposalTrigger[] = [];
  for (const raw of settled) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    switch (key) {
      case "name":
        proposal.name = value.slice(0, 200);
        break;
      case "face": {
        const face: { shape?: string; color?: string; expression?: string } = {};
        for (const token of value.toLowerCase().split(/[\s,]+/)) {
          if (SHAPE_IDS.has(token)) face.shape = token;
          else if (COLOR_IDS.has(token)) face.color = token;
          else if (EXPRESSION_IDS.has(token)) face.expression = token;
        }
        if (Object.keys(face).length) proposal.face = face;
        break;
      }
      case "responsibility":
        proposal.responsibility = value;
        break;
      case "instructions":
        if (value.toLowerCase() !== "none") proposal.instructions = value;
        break;
      case "trigger": {
        const [when = "", title = "", prompt = ""] = value.split("::").map((part) => part.trim());
        if (!when) break;
        triggers.push({ when, title, prompt, schedule: parseScheduleSpec(when) });
        break;
      }
      case "needs":
        proposal.needs = list(value);
        break;
      case "permissions":
        proposal.permissions = list(value)
          .map((item) => item.toLowerCase().replace(/\s+/g, "_"))
          .filter((item): item is keyof AgentPermissions =>
            GRANTABLE.has(item as keyof AgentPermissions),
          );
        break;
    }
  }
  proposal.triggers = triggers;
  return proposal;
}

/** The newest proposal in a builder conversation; later replies replace earlier ones. */
export function proposalFromMessages(
  messages: ReadonlyArray<{ role: string; text: string }>,
): AgentProposal | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const proposal = parseProposal(message.text);
    if (proposal) return proposal;
  }
  return null;
}

/** A `propose_agent` schedule as the read model the card and the save share. */
function proposalSchedule(schedule: ScheduledTaskUpsertSchedule): ScheduledTaskSchedule {
  if (schedule.type !== "webhook") return schedule;
  if (schedule.signature == null) return { ...schedule, signature: null };
  // Signing secrets are owner settings, never part of a proposal.
  const { secret: _secret, secretRef: _secretRef, ...signature } = schedule.signature;
  return { ...schedule, signature };
}

/** A `propose_agent` call as the card reads it: whole, so always complete. */
export function structuredProposal(proposal: AgentBuilderProposal): AgentProposal {
  return {
    name: proposal.name,
    face: {
      ...(SHAPE_IDS.has(proposal.face.shape) ? { shape: proposal.face.shape } : {}),
      ...(COLOR_IDS.has(proposal.face.color) ? { color: proposal.face.color } : {}),
      ...(EXPRESSION_IDS.has(proposal.face.expression)
        ? { expression: proposal.face.expression }
        : {}),
    },
    responsibility: proposal.responsibility,
    ...(proposal.instructions ? { instructions: proposal.instructions } : {}),
    triggers: proposal.triggers.map((trigger) => {
      const schedule = proposalSchedule(trigger.schedule);
      return {
        when: scheduleInWords(schedule),
        title: trigger.title,
        prompt: trigger.prompt,
        schedule,
      };
    }),
    needs: [...proposal.needs],
    permissions: (Object.keys(proposal.permissions) as Array<keyof AgentPermissions>).filter(
      (grant) => proposal.permissions[grant] === true && GRANTABLE.has(grant),
    ),
    ...(proposal.projectFolderId ? { projectFolderId: proposal.projectFolderId } : {}),
    complete: true,
  };
}

/**
 * The newest structured proposal in the thread; later `propose_agent` calls
 * replace earlier ones. Null until the first call lands, when the card falls
 * back to the fenced block.
 */
export function proposalFromTurnItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): AgentProposal | null {
  const item = items.findLast(
    (candidate): candidate is Extract<OrchestrationV2TurnItem, { type: "agent_proposal" }> =>
      candidate.type === "agent_proposal",
  );
  return item ? structuredProposal(item.proposal) : null;
}

// Schedules -------------------------------------------------------------------

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const EVENT_ALIASES: ReadonlyArray<[RegExp, AgentEventKind]> = [
  [/checks? fail/, "pr.checks_failed"],
  [/pr.*merge/, "pr.merged"],
  [/pr.*(open|updat|chang)|pull request/, "pr.updated"],
  [/work.*(fail)/, "work.failed"],
  [/work.*(review)/, "work.review_ready"],
  [/work.*(finish|complet|done)/, "work.completed"],
  [/(item|commitment).*due/, "commitment.due"],
];

/** "9am", "9:30 pm", "09:00" or "17:00" as "HH:MM"; null when it isn't a time. */
export function parseTimeOfDay(text: string): string | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const meridiem = match[3];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hours > 23) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * The builder's "<when>" as a schedule: "every 30 minutes", "daily at 9am",
 * "weekdays at 09:00", "on mon,wed at 18:00", "when pr.merged" or "webhook".
 * Null when the words don't fit the grammar.
 */
export function parseScheduleSpec(spec: string): ScheduledTaskSchedule | null {
  const text = spec.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  if (/^(on )?(a )?webhook( request)?$/.test(text)) return { type: "webhook", signature: null };
  const interval = text.match(/^every (\d+)? ?(minute|min|hour|hr|day)s?$/);
  if (interval) {
    const count = Number(interval[1] ?? "1");
    const unit = interval[2]!;
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return count >= 1 ? { type: "interval", everyMs: count * ms } : null;
  }
  if (text === "hourly") return { type: "interval", everyMs: 3_600_000 };
  if (text === "daily") return { type: "interval", everyMs: 86_400_000 };
  const event = text.match(/^when (.+)$/);
  if (event) {
    const subject = event[1]!;
    if (EVENT_KINDS.has(subject)) return { type: "event", event: subject as AgentEventKind };
    const alias = EVENT_ALIASES.find(([pattern]) => pattern.test(subject));
    return alias ? { type: "event", event: alias[1] } : null;
  }
  const timed = text.match(/^(?:(.+?) )?(?:at )?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
  if (!timed) return null;
  const timeOfDay = parseTimeOfDay(timed[2]!);
  if (!timeOfDay) return null;
  const days = (timed[1] ?? "daily").replace(/^(every|each|on) /, "");
  if (days === "daily" || days === "day") return { type: "fixed_time", timeOfDay };
  if (days === "weekdays" || days === "weekday")
    return { type: "fixed_time", timeOfDay, weekdays: [1, 2, 3, 4, 5] };
  if (days === "weekends" || days === "weekend")
    return { type: "fixed_time", timeOfDay, weekdays: [0, 6] };
  const weekdays = [
    ...new Set(
      days
        .split(/[,\s]+|and/)
        .map((day) => DAY_INDEX[day.slice(0, 3)])
        .filter((day): day is number => day !== undefined),
    ),
  ].toSorted((a, b) => a - b);
  return weekdays.length > 0 ? { type: "fixed_time", timeOfDay, weekdays } : null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "9am", "9:30am", "5pm" from "HH:MM". */
export function timeOfDayInWords(timeOfDay: string): string {
  const [hoursText = "0", minutesText = "00"] = timeOfDay.split(":");
  const hours = Number(hoursText);
  const meridiem = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutesText === "00" ? `${hour12}${meridiem}` : `${hour12}:${minutesText}${meridiem}`;
}

/**
 * A schedule the way you'd say it: "Every weekday at 9am", "Every 2 hours",
 * "Mon, Wed at 6pm", "When PR checks fail", "When its webhook is called".
 */
export function scheduleInWords(
  schedule:
    | ScheduledTaskSchedule
    | { type: "interval"; everyMs: number }
    | { type: "fixed_time"; timeOfDay: string; weekdays?: ReadonlyArray<number> | undefined }
    | { type: "webhook" }
    | { type: "event"; event: AgentEventKind },
): string {
  switch (schedule.type) {
    case "webhook":
      return "When its webhook is called";
    case "event":
      return EVENT_TRIGGER_LABEL[schedule.event];
    case "interval": {
      const minutes = Math.round(schedule.everyMs / 60_000);
      if (minutes % 1440 === 0)
        return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
      if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
      return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
    }
    case "fixed_time": {
      const days = [...new Set(schedule.weekdays ?? [])].toSorted((a, b) => a - b);
      const when =
        days.length === 0 || days.length === 7
          ? "Every day"
          : days.join() === "1,2,3,4,5"
            ? "Every weekday"
            : days.join() === "0,6"
              ? "Weekends"
              : days.map((day) => DAY_NAMES[day] ?? "?").join(", ");
      return `${when} at ${timeOfDayInWords(schedule.timeOfDay)}`;
    }
  }
}

// Creating --------------------------------------------------------------------

/** A name and a responsibility are enough to create; the rest has defaults. */
export function canCreateProposal(proposal: AgentProposal | null): proposal is AgentProposal & {
  name: string;
  responsibility: string;
} {
  return Boolean(proposal?.name?.trim() && proposal?.responsibility?.trim());
}

/**
 * The project a proposed agent is created in: the owner's pick on the card
 * (null being No project), else the folder the builder named, else the one the
 * builder conversation is filed in. A folder that no longer exists counts as
 * none named.
 */
export function proposalProjectFolderId(input: {
  /** Undefined until the owner picks on the card. */
  readonly chosen: ProjectLabelId | null | undefined;
  readonly proposed: ProjectLabelId | undefined;
  readonly builder: ProjectLabelId | null;
  readonly exists: (id: ProjectLabelId) => boolean;
}): ProjectLabelId | null {
  const known = (id: ProjectLabelId | null | undefined) =>
    id !== null && id !== undefined && input.exists(id) ? id : null;
  if (input.chosen !== undefined) return known(input.chosen);
  return known(input.proposed) ?? known(input.builder);
}

/** The create payload for a proposal: the owner's default model, defaults for the rest. */
export function proposalToDraft(
  proposal: AgentProposal & { name: string },
  context: {
    seed: string;
    modelSelection: ModelSelection;
    projectId: ProjectId;
    /** Files the new agent's conversation in this folder; null in none. Omit for the server's default. */
    projectFolderId?: ProjectLabelId | null;
  },
): AgentDraft {
  const permissions = { ...defaultAgentPermissions };
  for (const grant of proposal.permissions) permissions[grant] = true;
  return {
    name: proposal.name.trim(),
    avatar: {
      seed: context.seed,
      ...(proposal.face?.shape ? { shape: proposal.face.shape } : {}),
      ...(proposal.face?.color ? { color: proposal.face.color } : {}),
      ...(proposal.face?.expression ? { expression: proposal.face.expression } : {}),
    },
    responsibility: proposal.responsibility?.trim() ?? "",
    instructions: proposal.instructions?.trim() ?? "",
    modelSelection: context.modelSelection,
    runtimeMode: "full-access",
    projectId: context.projectId,
    ...(context.projectFolderId !== undefined ? { projectFolderId: context.projectFolderId } : {}),
    dailyRunCap: 24,
    permissions,
  };
}

/** The triggers worth saving: those whose "when" parsed. Title and prompt fall back sensibly. */
export function proposalTriggers(proposal: AgentProposal): Array<Omit<AgentTrigger, "id">> {
  return proposal.triggers.flatMap((trigger) =>
    trigger.schedule
      ? [
          {
            title: (trigger.title || scheduleInWords(trigger.schedule)).slice(0, 200),
            prompt: trigger.prompt || proposal.responsibility || trigger.when,
            schedule: trigger.schedule,
            enabled: true,
          },
        ]
      : [],
  );
}

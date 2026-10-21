/**
 * The agent builder: a conversation with the owner's default model that ends in an
 * agent. The model talks in prose and keeps the live proposal in one fenced `agent`
 * block of `key: value` lines, so the card can assemble line by line while the reply
 * streams. Everything here is pure: the preamble, the parser, the schedule grammar,
 * and the turn from a proposal into the create payload.
 */
import {
  defaultAgentPermissions,
  type AgentAvatar,
  type AgentEventKind,
  type AgentPermissions,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import { EXPRESSIONS as AGENT_FACE_EXPRESSIONS } from "~/components/agents/face/engine/expressions";
import {
  COLORS as AGENT_FACE_COLORS,
  SHAPES as AGENT_FACE_SHAPES,
} from "~/components/agents/face/engine/skins";
import { EVENT_TRIGGER_LABEL } from "./agentWorkspace.logic";
import type { AgentDraft, AgentTrigger } from "./agents.types";

export const BUILDER_THREAD_TITLE = "New agent";
/** Separates the hidden preamble from what the owner typed in the first message. */
export const BUILDER_OWNER_MARKER = "=== What I want ===";

export const BUILDER_EXAMPLES: ReadonlyArray<string> = [
  "Watch my GitHub PRs and summarize them every morning",
  "Be my Halloween shirt shopper",
  "Keep track of what I owe clients and follow up",
];

const SHAPE_IDS = new Set<string>(AGENT_FACE_SHAPES.map((shape) => shape.id));
const COLOR_IDS = new Set<string>(AGENT_FACE_COLORS.map((color) => color.id));
const EXPRESSION_IDS = new Set<string>(AGENT_FACE_EXPRESSIONS.map((expression) => expression.id));
const EVENT_KINDS = new Set<string>(Object.keys(EVENT_TRIGGER_LABEL));
const GRANTABLE: ReadonlyArray<keyof AgentPermissions> = [
  "send",
  "create_pr",
  "merge",
  "deploy",
  "delete",
];

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
  /** The block closed, so the builder finished this version. */
  complete: boolean;
}

const FENCE = "```agent";

/** What the first message says before the owner's words. */
export function builderPreamble(description: string): string {
  return `You are helping me set up a new Cogenly agent: a persistent specialist with its own conversation, one responsibility, and optional triggers that wake it on a schedule or when something happens. Do not read or change files and do not run commands here; we are only talking.

How to reply:
- One or two short, warm sentences. No headings, no lists.
- Ask at most one or two short questions, and only when you cannot propose anything sensible without the answers. Otherwise propose right away and let me adjust.
- Whenever you propose or change the agent, end your reply with exactly one fenced block whose language is "agent", one field per line as "key: value". Always give the whole current proposal, not only what changed. Nothing after the block.

Fields:
name: a short name, one to three words
face: <shape> <color> <expression> (shape: ${[...SHAPE_IDS].join(" ")}; color: ${[...COLOR_IDS].join(" ")}; expression: ${[...EXPRESSION_IDS].join(" ")})
responsibility: one sentence, what it owns
instructions: one or two sentences on how it should work and talk to me (optional)
trigger: <when> :: <short title> :: <what to do when woken> (one line per trigger; leave out if it only needs to answer me. <when> is one of: every N minutes|hours|days; daily at HH:MM; weekdays at HH:MM; weekends at HH:MM; on mon,wed,fri at HH:MM; when ${[...EVENT_KINDS].join("|")}; webhook)
needs: comma-separated tools or integrations it will rely on, or none
permissions: comma-separated extra grants from ${GRANTABLE.join(", ")}, only if the job truly needs them, else none

Example:
${FENCE}
name: PR Digest
face: nuage bleu attentif
responsibility: Watch my open pull requests and send me a morning summary.
instructions: Keep it short; flag anything that needs my review today.
trigger: weekdays at 09:00 :: Morning PR digest :: Review every open PR and post what changed and what needs me.
needs: GitHub
permissions: none
\`\`\`

${BUILDER_OWNER_MARKER}
${description.trim()}`;
}

/** The owner's words from a builder message: the first one carries the preamble. */
export function ownerText(text: string): string {
  const index = text.indexOf(BUILDER_OWNER_MARKER);
  return index === -1 ? text : text.slice(index + BUILDER_OWNER_MARKER.length).trim();
}

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
            GRANTABLE.includes(item as keyof AgentPermissions),
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

/** The create payload for a proposal: the owner's default model, defaults for the rest. */
export function proposalToDraft(
  proposal: AgentProposal & { name: string },
  context: { seed: string; modelSelection: ModelSelection; projectId: ProjectId },
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

/** The first message to the new agent, so it introduces itself and gets going. */
export function kickoffMessage(name: string): string {
  return `Hi ${name}! Say hello, then get started on what you own.`;
}

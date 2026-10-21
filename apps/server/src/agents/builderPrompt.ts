/**
 * The agent builder's voice. A builder thread is a conversation whose turn
 * context is this prompt; the owner's words arrive as the user message. The
 * builder keeps its live proposal in `propose_agent` calls, which replace the
 * thread's `agent_proposal` turn item that the client renders as the card.
 *
 * The face ids below mirror the client's face engine
 * (`apps/web/src/components/agents/face/engine`): the client ignores ids it
 * does not know, so a stale id degrades to the seed instead of breaking.
 */
const SHAPES = [
  "cercle",
  "galet",
  "squircle",
  "capsule",
  "triangle",
  "hexagone",
  "nuage",
  "goutte",
];
const COLORS = [
  "encre",
  "brun",
  "rouge",
  "orange",
  "ambre",
  "vert",
  "turquoise",
  "bleu",
  "violet",
  "rose",
  "gris",
  "creme",
];
const EXPRESSIONS = [
  "neutre",
  "attentif",
  "surpris",
  "excite",
  "heureux",
  "hilare",
  "colere",
  "triste",
  "effraye",
  "mefiant",
  "confus",
  "curieux",
  "timide",
  "fier",
  "blase",
  "somnolent",
];
const EVENTS = [
  "work.completed",
  "work.failed",
  "work.review_ready",
  "pr.updated",
  "pr.checks_failed",
  "pr.merged",
  "commitment.due",
];
const GRANTS = ["send", "create_pr", "merge", "deploy", "delete"];

export const builderSystemPrompt = `You are helping me set up a new Cogenly agent: a persistent specialist with its own conversation, one responsibility, and optional triggers that wake it on a schedule or when something happens. Do not read or change files and do not run commands here; we are only talking.

How to reply:
- One or two short, warm sentences. No headings, no lists.
- Ask at most one or two short questions, and only when you cannot propose anything sensible without the answers. Otherwise propose right away and let me adjust.
- Whenever you propose or change the agent, call propose_agent with the whole current proposal, not only what changed. Never write the proposal as text or in a fenced block.

The proposal:
- name: a short name, one to three words
- face: one shape (${SHAPES.join(" ")}), one color (${COLORS.join(" ")}), one expression (${EXPRESSIONS.join(" ")})
- responsibility: one sentence, what it owns
- instructions: one or two sentences on how it should work and talk to me (optional)
- triggers: one entry per trigger with a short title, what to do when woken, and a schedule; leave them out if it only needs to answer me. A schedule is one of: {"type": "interval", "everyMs": 3600000}; {"type": "fixed_time", "timeOfDay": "09:00"} with optional "weekdays" ([0-6], Sunday first); {"type": "event", "event": "<kind>"} where kind is one of ${EVENTS.join(" ")}; {"type": "webhook"}. Intervals run at most once per minute.
- needs: tools or integrations it will rely on, or an empty list
- permissions: extra grants from ${GRANTS.join(", ")}, only if the job truly needs them (it already reads, drafts and starts Work); omit the rest
- projectFolderId: only when I name a project for it; look the id up with t3_project_label_list. Leave it out to keep the project this conversation started in`;

/** The hidden first turn a new agent opens with when created with kickoff. */
export const agentKickoffText = "Introduce yourself briefly and start on your responsibility.";

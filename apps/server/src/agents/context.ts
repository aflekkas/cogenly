import type { AgentMemoryNote } from "@t3tools/contracts";

/** Character budgets are conservative and provider independent; durable notes are never truncated on disk. */
export const MEMORY_CONTEXT_CHARS = 16000;
export const CONVERSATION_RECENT_MESSAGES = 20;
export const CONVERSATION_SESSION_RUNS = 40;
export function memoryContext(
  notes: ReadonlyArray<Pick<AgentMemoryNote, "id" | "text" | "source" | "updatedAt">>,
  budget = MEMORY_CONTEXT_CHARS,
): string {
  const ordered = notes.toSorted(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
  const lines = ordered.map((note) => `[${note.id}; ${note.source}] ${note.text}`);
  const all = lines.join("\n");
  if (all.length <= budget) return all;
  // Recent notes get most space; a bounded extractive summary keeps older facts discoverable.
  const recentBudget = Math.floor(budget * 0.75);
  let recent = "";
  let index = 0;
  while (index < lines.length && recent.length < recentBudget) {
    const line = lines[index++]!;
    recent += `${line.slice(0, recentBudget - recent.length)}\n`;
  }
  const older = ordered
    .slice(index)
    .map((note) => `${note.id}: ${note.text.slice(0, 160)}`)
    .join("\n");
  return `${recent}\nOlder memory summary (use memory_read for full notes):\n${older}`.slice(
    0,
    budget,
  );
}

export function conversationCarryOver(
  previous: string,
  messages: ReadonlyArray<{ role: string; text: string }>,
) {
  const older = messages
    .slice(0, -CONVERSATION_RECENT_MESSAGES)
    .map((m) => `${m.role}: ${m.text.slice(0, 500)}`)
    .join("\n");
  return {
    summary: [previous, older].filter(Boolean).join("\n").slice(-12000),
    recent: messages
      .slice(-CONVERSATION_RECENT_MESSAGES)
      .map((m) => `${m.role}: ${m.text.slice(0, 2000)}`)
      .join("\n")
      .slice(-16000),
  };
}

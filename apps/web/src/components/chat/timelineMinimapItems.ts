import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { markdownPreviewText } from "@t3tools/client-runtime/work-log/reasoning-text";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
  /** Typed by the user, not sent by an agent, automation or Cogenly. */
  readonly typed: boolean;
}

/** Keep full source text untouched until a minimap preview is opened. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
      typed: resolveUserMessagePresentation(row.message).attribution === null,
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

/** Previews read as plain text: no literal `**`, `#` or `[link](url)` markup. */
function compactMinimapPreview(text: string | null | undefined) {
  const compact = text ? markdownPreviewText(text) : "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: compactMinimapPreview(item.userText),
        assistantText: compactMinimapPreview(item.assistantText),
      };
}

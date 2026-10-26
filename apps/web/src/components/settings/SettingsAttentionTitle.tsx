import type { ReactNode } from "react";

import { BadgeDot } from "../ui/badge-dot";
import {
  SETTINGS_PAGE_NEEDS_ATTENTION_LABEL,
  type SettingsAttentionTone,
} from "./settingsAttention.logic";

/**
 * A settings row or card title with the Settings dot after it, on the row an
 * open machine-health alert concerns (settingsAttention.logic). The rail's
 * Settings button and the settings nav show the same dot for the same alerts.
 */
export function SettingsAttentionTitle({
  tone,
  children,
}: {
  readonly tone: SettingsAttentionTone | null;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {children}
      <BadgeDot tone={tone} size="md" className="shrink-0" />
      {tone === null ? null : (
        <span className="sr-only">, {SETTINGS_PAGE_NEEDS_ATTENTION_LABEL}</span>
      )}
    </span>
  );
}

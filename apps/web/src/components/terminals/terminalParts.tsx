import {
  AuthPreviewOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  detectLocalServerUrl,
  terminalRunStateTone,
  type TerminalRunState,
  type TerminalRunTone,
} from "../AgentTerminalsPanel.logic";
import { openTerminalLinkInPreview } from "../preview/openTerminalLinkInPreview";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { stackedThreadToast, toastManager } from "../ui/toast";

export const RUN_TONE_TEXT: Record<TerminalRunTone, string> = {
  live: "text-success",
  success: "text-muted-foreground",
  muted: "text-muted-foreground",
  danger: "text-destructive-foreground",
};

/**
 * A static dot for how a run stands, so the command carries the row. Live is
 * green, never a spinner; a failure is red; success and a bare exit stay faint;
 * a stopped run is a hollow ring. Every state sits in the same box, so a column
 * of them lines up.
 */
export function RunStateGlyph({ state }: { state: TerminalRunState }) {
  return (
    <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
      <span className={cn("size-1.5 rounded-full", RUN_STATE_DOT[state.kind])} />
    </span>
  );
}

const RUN_STATE_DOT: Record<TerminalRunState["kind"], string> = {
  starting: "bg-success ring-3 ring-success/15",
  running: "bg-success ring-3 ring-success/15",
  succeeded: "bg-muted-foreground/25",
  ended: "bg-muted-foreground/25",
  killed: "border border-muted-foreground/60",
  failed: "bg-destructive-foreground/85",
  error: "bg-destructive-foreground/85",
};

export function runToneText(state: TerminalRunState): string {
  return RUN_TONE_TEXT[terminalRunStateTone(state)];
}

/** Centered note that says what an empty section is for. */
export function TerminalSectionEmpty(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <Empty size="sm" className="min-h-0">
      <EmptyHeader>
        <EmptyMedia>{props.icon}</EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

const detectedUrls = new Map<string, string>();
// Enough of the previous chunk to catch a URL split across two writes.
const SCAN_OVERLAP = 256;

/**
 * The local address a live run announced, from its output. Observes the run
 * only until an address shows up, then remembers it for the session.
 */
export function useDetectedRunUrl(
  threadRef: ScopedThreadRef,
  terminalId: string,
  live: boolean,
): string | null {
  const key = `${threadRef.environmentId}:${threadRef.threadId}:${terminalId}`;
  const [found, setFound] = useState(() => detectedUrls.get(key) ?? null);
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  const observed = useEnvironmentQuery(
    live && found === null && canRead
      ? terminalEnvironment.observe({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, terminalId },
        })
      : null,
  );
  const output = observed.data?.output ?? null;
  const scannedRef = useRef({ generation: -1, resetVersion: -1, offset: 0 });
  useEffect(() => {
    if (output === null || found !== null) return;
    const scanned = scannedRef.current;
    const fresh =
      scanned.generation !== output.generation || scanned.resetVersion !== output.resetVersion;
    const from = fresh ? 0 : Math.max(0, scanned.offset - SCAN_OVERLAP);
    const text = output.chunks
      .filter((chunk) => chunk.startOffset + chunk.data.length > from)
      .map((chunk) => chunk.data.slice(Math.max(0, from - chunk.startOffset)))
      .join("");
    scannedRef.current = {
      generation: output.generation,
      resetVersion: output.resetVersion,
      offset: output.nextOffset,
    };
    const url = detectLocalServerUrl(text);
    if (url === null) return;
    detectedUrls.set(key, url);
    setFound(url);
  }, [found, key, output]);
  return live ? found : null;
}

/** Opens a run's URL where "Open links in" says: the preview browser or the system one. */
export function useOpenRunUrl(threadRef: ScopedThreadRef) {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return (url: string, forceBrowser = false) => {
    const fallbackToBrowser = () => {
      const localApi = readLocalApi();
      if (localApi) {
        void localApi.shell.openExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    };
    if (!readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)) {
      fallbackToBrowser();
      return;
    }
    void openTerminalLinkInPreview({
      url,
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser,
    }).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** A wall-clock time; includes the date once it is not today. */
export function formatRunTimestamp(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toDateString() === new Date().toDateString()
    ? clockFormat.format(date)
    : dateTimeFormat.format(date);
}

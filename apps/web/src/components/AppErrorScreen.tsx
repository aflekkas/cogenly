import { Check, Copy } from "lucide";
import { useEffect, useMemo, useRef } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { PIXEL_MARK_URL } from "../lib/pixelMark";
import { MorphIcon } from "./MorphIcon";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { DisclosureChevron } from "./ui/disclosure";

/**
 * The app's full-page error state: the pixel mark, a title, one line and Reload. A quiet row
 * below holds Show details, Try again and Copy error; the details (build, path, time, the
 * error and its stack and causes) start collapsed. The boot error in lib/bootError.ts mirrors
 * this layout in plain DOM for failures before React mounts.
 */
export function AppErrorScreen({
  error,
  pathname,
  onRetry,
}: {
  error: unknown;
  pathname: string;
  onRetry: () => void;
}) {
  const report = useMemo(() => errorReport(error, pathname), [error, pathname]);
  const reloadRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    reloadRef.current?.focus();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12 text-foreground">
      <Collapsible className="flex w-full max-w-sm flex-col items-center text-center">
        <img alt="" className="size-9 select-none" draggable={false} src={PIXEL_MARK_URL} />
        <h1 className="mt-5 text-lg font-semibold tracking-tight">Cogenly hit a problem</h1>
        <p className="mt-1 text-sm text-muted-foreground">Reload to pick up where you left off.</p>
        <Button className="mt-5" ref={reloadRef} size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-1">
          <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
            <DisclosureChevron />
            Details
          </CollapsibleTrigger>
          <Button size="xs" variant="ghost-muted" onClick={onRetry}>
            Try again
          </Button>
          <CopyErrorButton report={report} />
        </div>
        <CollapsiblePanel className="w-full">
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/70 bg-card px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap text-foreground/80">
            {report}
          </pre>
        </CollapsiblePanel>
      </Collapsible>
    </main>
  );
}

/** Copies the full error report and swaps to a check mark for a moment as confirmation. */
function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="xs" variant="ghost-muted" onClick={() => copyToClipboard(report)}>
      <MorphIcon className={cn(isCopied && "text-success")} icon={isCopied ? Check : Copy} />
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * Full error text for bug reports: app build, page path, time, then the stack
 * and any cause chain. Takes the pathname only so tokens in the query never
 * land on the clipboard.
 */
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

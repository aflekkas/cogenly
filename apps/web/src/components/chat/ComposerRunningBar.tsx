import { AuthTerminalOperateScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentTerminalEntries, runningAgentCommandsSummary } from "../AgentTerminalsPanel.logic";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

/**
 * A tab attached to the top of the composer while the agent's background
 * commands run: the newest command (or a count) and a Stop that kills them.
 * Renders nothing when no agent command is running.
 */
export const ComposerRunningBar = memo(function ComposerRunningBar(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
}) {
  const { environmentId, threadId } = props;
  const sessions = useKnownTerminalSessions({ environmentId, threadId });
  const summary = useMemo(
    () => runningAgentCommandsSummary(agentTerminalEntries(sessions ?? [])),
    [sessions],
  );
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");

  if (summary === null || threadId === null) return null;

  const stop = () => {
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    for (const terminalId of summary.terminalIds) {
      void killTerminal({ environmentId, input: { threadId, terminalId } });
    }
  };

  return (
    <div
      data-chat-composer-running-bar="true"
      className={cn(
        // Narrower than the composer so it reads as a tab coming out of it; the
        // overlap tucks its bottom under the composer like the other attachments.
        "relative mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-1.25rem)]",
        "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none",
      )}
    >
      <ComposerBanner.Root aria-live="polite">
        <ComposerBanner.Row>
          <ComposerBanner.Icon className="text-foreground">
            <ComposerBanner.Dot />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="flex-none text-muted-foreground">Running:</span>
            <span className="min-w-0 truncate font-mono text-foreground">{summary.label}</span>
          </ComposerBanner.Content>
          {canOperate ? (
            <ComposerBanner.Actions>
              <Button
                size="xs"
                variant="ghost"
                aria-label={
                  summary.terminalIds.length === 1
                    ? `Stop ${summary.label}`
                    : `Stop ${summary.terminalIds.length} running commands`
                }
                onClick={stop}
              >
                Stop
              </Button>
            </ComposerBanner.Actions>
          ) : null}
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </div>
  );
});

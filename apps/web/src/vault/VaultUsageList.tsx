import type { AgentId, EnvironmentId, VaultItemId, VaultUsageEntry } from "@t3tools/contracts";

import { MarkdownThreadLink } from "../components/chat/MarkdownThreadLink";
import { Badge } from "../components/ui/badge";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { vaultActionLabel, vaultOutcomeLabel, vaultOutcomeTone } from "./vault.logic";

/**
 * Who used which item, where, and what happened. `itemName` is passed only
 * for the all-activity view, where entries span items.
 */
export function VaultUsageList(props: {
  readonly environmentId: EnvironmentId;
  readonly usage: ReadonlyArray<VaultUsageEntry>;
  readonly agentName: (id: AgentId) => string | undefined;
  readonly itemName?: (id: VaultItemId) => string | undefined;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {props.usage.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
        >
          <Badge size="sm" variant={vaultOutcomeTone(entry.outcome)}>
            {vaultOutcomeLabel(entry.outcome)}
          </Badge>
          <span className="text-foreground">{vaultActionLabel(entry.action)}</span>
          {props.itemName ? (
            <span className="text-foreground">
              {props.itemName(entry.itemId) ?? "a deleted item"}
            </span>
          ) : null}
          {entry.domain ? <span>on {entry.domain}</span> : null}
          <span>·</span>
          <span>
            {entry.agentId
              ? (props.agentName(entry.agentId) ?? "A deleted agent")
              : entry.threadId
                ? "You"
                : "Cogenly"}
          </span>
          {entry.threadId ? (
            <>
              <span>in</span>
              <MarkdownThreadLink
                environmentId={props.environmentId}
                threadId={entry.threadId}
                label="a chat"
              />
            </>
          ) : null}
          <span>· {formatRelativeTimeLabel(entry.at)}</span>
        </li>
      ))}
    </ol>
  );
}

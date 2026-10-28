import type { AgentId, EnvironmentId, VaultItemId, VaultUsageEntry } from "@cogenly/contracts";

import { MarkdownThreadLink } from "../components/chat/MarkdownThreadLink";
import { SettingsListMeta } from "../components/settings/SettingsList";
import { SettingsStatusBadge } from "../components/settings/SettingsStatus";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  groupVaultUsage,
  vaultActionLabel,
  vaultOutcomeLabel,
  vaultOutcomeTone,
  vaultSavedFromThread,
} from "./vault.logic";

/**
 * Who used which item, where, and what happened, with back-to-back identical
 * uses folded into one line. `itemName` is passed only for the all-activity
 * view, where entries span items.
 */
export function VaultUsageList(props: {
  readonly environmentId: EnvironmentId;
  readonly usage: ReadonlyArray<VaultUsageEntry>;
  readonly agentName: (id: AgentId) => string | undefined;
  readonly itemName?: (id: VaultItemId) => string | undefined;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {groupVaultUsage(props.usage).map(({ entry, count }) => {
        const itemName = props.itemName ? (
          <span className="text-foreground">
            {props.itemName(entry.itemId) ?? "a deleted item"}
          </span>
        ) : null;
        const saved = vaultSavedFromThread(entry);
        const time = `${count > 1 ? `${count} times, latest ` : ""}${formatRelativeTimeLabel(entry.at)}`;
        return (
          <li key={entry.id} className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            <SettingsStatusBadge tone={vaultOutcomeTone(entry.outcome)}>
              {vaultOutcomeLabel(entry.outcome)}
            </SettingsStatusBadge>
            {/* Facts separate with SettingsListMeta's dots, which wrap with the fact after them. */}
            <SettingsListMeta>
              {saved ? (
                // The user typed it on an agent's sign-in card in that thread.
                <span>
                  {itemName}
                  {itemName ? " " : null}
                  <span className={itemName ? undefined : "text-foreground"}>
                    {saved.updated ? "Updated from" : "Saved from"}
                  </span>{" "}
                  <MarkdownThreadLink
                    environmentId={props.environmentId}
                    threadId={saved.threadId}
                    label="a chat"
                  />{" "}
                  by{" "}
                  {entry.agentId
                    ? (props.agentName(entry.agentId) ?? "a deleted agent")
                    : "its agent"}
                </span>
              ) : (
                <span>
                  <span className="text-foreground">{vaultActionLabel(entry.action)}</span>
                  {itemName ? " " : null}
                  {itemName}
                  {entry.domain ? ` on ${entry.domain}` : null}
                </span>
              )}
              {saved ? null : (
                <span>
                  {entry.agentId
                    ? (props.agentName(entry.agentId) ?? "A deleted agent")
                    : entry.threadId
                      ? "You"
                      : "Cogenly"}
                  {entry.threadId ? (
                    <>
                      {" in "}
                      <MarkdownThreadLink
                        environmentId={props.environmentId}
                        threadId={entry.threadId}
                        label="a chat"
                      />
                    </>
                  ) : null}
                </span>
              )}
              <span>{time}</span>
            </SettingsListMeta>
          </li>
        );
      })}
    </ol>
  );
}

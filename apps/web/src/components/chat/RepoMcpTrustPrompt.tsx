import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@cogenly/contracts";
import { useState } from "react";
import { repoMcpTrustRpc } from "../../rpc/repoMcpTrust";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { DisclosurePanel } from "../ui/disclosure";
import { Button } from "../ui/button";
import { ThreadPromptCard } from "./ThreadPromptCard";

/** A repository's local execution consent stays visible after the agent finishes. */
export function RepoMcpTrustPrompt({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    repoMcpTrustRpc.pending({ environmentId, input: { threadId } }),
  );
  const canRespond = useAtomValue(repoMcpTrustRpc.respond.permissionAtom(environmentId));
  const respond = useAtomCommand(repoMcpTrustRpc.respond);
  const [pending, setPending] = useState(false);
  return (
    <DisclosurePanel open={(query.data?.prompts.length ?? 0) > 0}>
      {(query.data?.prompts ?? []).map((prompt) => (
        <div key={prompt.id} className="px-4 py-2">
          <ThreadPromptCard>
            <p className="text-sm font-medium">
              {prompt.decision === "pending"
                ? "This repo wants to run local MCP servers:"
                : prompt.decision === "trusted"
                  ? "Local MCP servers trusted"
                  : "Local MCP servers not trusted"}
            </p>
            <p className="text-xs text-muted-foreground">{prompt.remote}</p>
            <ul className="space-y-1 text-sm">
              {prompt.servers.map((server) => (
                <li key={server.name}>
                  <span className="font-medium">{server.name}</span>:{" "}
                  <code className="break-all">
                    {[server.command, ...server.args].map((arg) => JSON.stringify(arg)).join(" ")}
                  </code>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Trust makes these servers available on your next turn. Changes to their definitions
              need your trust again.
            </p>
            <div className="flex gap-2">
              {[
                { trust: true, label: "Trust" },
                { trust: false, label: "Don't trust" },
              ].map(({ trust, label }) => (
                <Button
                  key={label}
                  size="sm"
                  variant={trust ? "default" : "outline"}
                  disabled={
                    !canRespond ||
                    pending ||
                    (trust ? prompt.decision === "trusted" : prompt.decision === "denied")
                  }
                  onClick={() => {
                    setPending(true);
                    void respond({
                      environmentId,
                      input: { threadId, id: prompt.id, trust },
                    }).finally(() => setPending(false));
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </ThreadPromptCard>
        </div>
      ))}
    </DisclosurePanel>
  );
}

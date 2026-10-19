import type { AgentId, EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../components/chat/threadDetailsPanelStyles";
import { Button } from "../components/ui/button";
import { filterFacts } from "./facts.logic";
import { FactEditorDialog, FactList, factInputFromDraft } from "./FactList";
import { useFactActions, useFactNavigation, useFacts } from "./useFacts";

/**
 * An agent's Memory: the facts it owns, proposals first. Owner-added facts belong to the
 * agent and stay private unless tagged with projects it may read.
 */
export function AgentFactsSection(props: {
  agent: { environmentId: EnvironmentId; id: AgentId; name: string };
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
}) {
  const { agent } = props;
  const navigate = useNavigate();
  const list = useFacts(agent.environmentId, { agentId: agent.id });
  const actions = useFactActions(agent.environmentId, list.refresh);
  const navigation = useFactNavigation(agent.environmentId);
  const [creating, setCreating] = useState(false);
  const facts = useMemo(() => filterFacts(list.facts, { status: "current" }), [list.facts]);
  const hidden = list.facts.length - facts.length;
  // Facts here are this agent's own, so no other agent name is needed.
  const agentName = (id: string) => (id === agent.id ? agent.name : undefined);
  return (
    <ThreadDetailsSection
      headingId="agent-memory"
      title="Memory"
      actions={
        <ThreadDetailsControl
          part="icon"
          aria-label={`Remember something for ${agent.name}`}
          disabled={!actions.canWrite}
          onClick={() => setCreating(true)}
        >
          <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        </ThreadDetailsControl>
      }
    >
      {list.error !== null ? (
        <p className="px-2 text-xs text-destructive">{list.error}</p>
      ) : !list.isLoaded ? (
        <p className="px-2 text-xs text-muted-foreground">Loading memory…</p>
      ) : facts.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          Nothing yet. {agent.name} proposes facts as it works; you confirm them here.
        </p>
      ) : (
        <FactList
          environmentId={agent.environmentId}
          facts={facts}
          labels={props.labels}
          agentName={agentName}
          actions={actions}
          {...navigation}
        />
      )}
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => void navigate({ to: "/settings/memory" })}
      >
        {hidden > 0 ? `All memory, including ${hidden} replaced or forgotten` : "All memory"}
      </Button>
      {creating ? (
        <FactEditorDialog
          title={`Remember for ${agent.name}`}
          description={`Saved as confirmed and owned by ${agent.name}. Untagged facts stay private to you and ${agent.name}.`}
          labels={props.labels}
          initial={null}
          saveLabel="Remember"
          onClose={() => setCreating(false)}
          onSave={async (draft) => {
            const saved = await actions.create(
              factInputFromDraft(draft, { sourceRefs: [], agentId: agent.id }),
            );
            if (saved) setCreating(false);
          }}
        />
      ) : null}
    </ThreadDetailsSection>
  );
}

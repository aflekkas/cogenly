import {
  SettingsListToolbar,
  SettingsListSearch,
  SettingsListFilter,
  SettingsListEmpty,
} from "./SettingsList";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import type { AgentId, ProjectLabelId } from "@cogenly/contracts";
import { BrainIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAgents } from "../../agents/agentsClient";
import { FACT_STATUS_FILTERS, filterFacts, type FactStatusFilter } from "../../memory/facts.logic";
import { FactEditorDialog, FactList, factInputFromDraft } from "../../memory/FactList";
import { peerSyncIndicator, pendingFor } from "../../machines/peerSync.logic";
import { useSyncPeers } from "../../machines/usePeerSync";
import { useFactActions, useFactNavigation, useFacts } from "../../memory/useFacts";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { Button } from "../ui/button";
import { PeerSyncRow } from "./PeerSyncRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ALL = "all";

/**
 * Settings → Memory. Facts chats and agents can use as context, with where each came
 * from. Follows the scope sentence's environment, like Projects.
 */
export function MemorySettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const sortedLabels = useMemo(
    () => sortProjectLabels(labels.map((label) => ({ label }))).map((entry) => entry.label),
    [labels],
  );
  const agents = useAgents().agents.filter((agent) => agent.environmentId === environmentId);
  const [labelId, setLabelId] = useState<string>(ALL);
  const [agentId, setAgentId] = useState<string>(ALL);
  const [status, setStatus] = useState<FactStatusFilter>("current");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useFacts(environmentId, {
    ...(labelId === ALL ? {} : { labelId: labelId as ProjectLabelId }),
    ...(agentId === ALL ? {} : { agentId: agentId as AgentId }),
  });
  const syncPeers = useSyncPeers(environmentId, "fact");
  const actions = useFactActions(environmentId, () => {
    list.refresh();
    syncPeers.refresh();
  });
  const navigation = useFactNavigation(environmentId);
  const facts = useMemo(
    () => filterFacts(list.facts, { status, query }),
    [list.facts, query, status],
  );
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name;
  const filtered = labelId !== ALL || agentId !== ALL || status !== "current" || query !== "";

  return (
    <>
      <SettingsSection
        id="memory"
        title="Memory"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!actions.canWrite}
            title={actions.canWrite ? undefined : "This connection cannot change memory."}
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-3" />
            Remember something
          </Button>
        }
      >
        {environmentId === null ? (
          <SettingsRow title="Choose a machine to see what it remembers." />
        ) : (
          <>
            <SettingsListToolbar>
              <SettingsListSearch label="Search memory" value={query} onValueChange={setQuery} />
              <SettingsListFilter
                label="Project"
                value={labelId}
                onValueChange={setLabelId}
                options={[
                  { value: ALL, label: "All projects" },
                  ...sortedLabels.map((label) => ({ value: label.id, label: label.name })),
                ]}
              />
              {agents.length > 0 ? (
                <SettingsListFilter
                  label="Agent"
                  value={agentId}
                  onValueChange={setAgentId}
                  options={[
                    { value: ALL, label: "All agents" },
                    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
                  ]}
                />
              ) : null}
              <SettingsListFilter
                label="Status"
                value={status}
                onValueChange={(value) => {
                  const option = FACT_STATUS_FILTERS.find((option) => option.value === value);
                  if (option) setStatus(option.value);
                }}
                options={FACT_STATUS_FILTERS}
              />
            </SettingsListToolbar>
            {list.error !== null ? (
              <SettingsRow title="Could not load memory" description={list.error} />
            ) : !list.isLoaded ? (
              <SettingsRow title="Loading memory…" />
            ) : facts.length === 0 ? (
              <SettingsListEmpty
                icon={<BrainIcon />}
                title={filtered ? "Nothing matches" : "Nothing remembered yet"}
                description={
                  filtered
                    ? "Try another project, agent or status."
                    : "Add something here. Agents can propose facts for you to confirm."
                }
              />
            ) : (
              <FactList
                environmentId={environmentId}
                facts={facts}
                labels={labels}
                agentName={agentName}
                actions={actions}
                {...navigation}
              />
            )}
          </>
        )}
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Chats tagged with a confirmed project, and agents allowed to read that project, use its
        confirmed facts as context. Proposals are never used until you confirm them. Private facts
        stay with you and the agent they belong to.
      </p>
      {syncPeers.peers.length > 0 ? (
        <SettingsSection id="memory-machines" title="Paired machines">
          {syncPeers.peers.map((peer) => (
            <PeerSyncRow
              key={peer.environmentId}
              machine={peer.label}
              indicator={peerSyncIndicator({
                machine: peer.label,
                online: peer.online,
                pending: pendingFor(peer, "fact"),
              })}
            />
          ))}
        </SettingsSection>
      ) : null}
      <OverlayPresence when={creating && environmentId}>
        {(environmentId) => (
          <FactEditorDialog
            title="Remember something"
            description="Saved as confirmed. You can correct or forget it later."
            environmentId={environmentId}
            labels={labels}
            initial={{
              subject: "",
              text: "",
              labelIds: labelId === ALL ? [] : [labelId as ProjectLabelId],
            }}
            saveLabel="Remember"
            onClose={() => setCreating(false)}
            onSave={async (draft) => {
              const saved = await actions.create(factInputFromDraft(draft, { sourceRefs: [] }));
              if (saved) setCreating(false);
            }}
          />
        )}
      </OverlayPresence>
    </>
  );
}

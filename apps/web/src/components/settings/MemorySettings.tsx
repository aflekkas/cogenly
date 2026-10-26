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

import { Button } from "../ui/button";
import { useAgents } from "../../agents/agentsClient";
import { FACT_STATUS_FILTERS, filterFacts, type FactStatusFilter } from "../../memory/facts.logic";
import { FactEditorDialog, FactList, factInputFromDraft } from "../../memory/FactList";
import { peerSyncIndicator, pendingFor } from "../../machines/peerSync.logic";
import { useSyncPeers } from "../../machines/usePeerSync";
import { useFactActions, useFactNavigation, useFacts } from "../../memory/useFacts";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { PeerSyncRow } from "./PeerSyncRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection, SettingsSectionAction } from "./settingsLayout";

const ALL = "all";
const NO_WRITE_TITLE = "This connection cannot change memory.";

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
  // Search and filters only once there is something to narrow down.
  const showToolbar = list.isLoaded && (list.facts.length > 0 || filtered);
  const clearFilters = () => {
    setLabelId(ALL);
    setAgentId(ALL);
    setStatus("current");
    setQuery("");
  };
  const rememberButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={!actions.canWrite}
      title={actions.canWrite ? undefined : NO_WRITE_TITLE}
      onClick={() => setCreating(true)}
    >
      <PlusIcon />
      Remember something
    </Button>
  );

  return (
    <>
      <SettingsSection
        footer="Chats in a project, and agents that can read it, use its confirmed facts. Facts without a project stay private. Proposals are never used until you confirm them."
        id="memory"
        title="Memory"
        headerAction={
          <SettingsSectionAction
            disabled={!actions.canWrite}
            title={actions.canWrite ? undefined : NO_WRITE_TITLE}
            onClick={() => setCreating(true)}
          >
            Remember something
          </SettingsSectionAction>
        }
      >
        {environmentId === null ? (
          <SettingsRow title="Choose a machine to see what it remembers." />
        ) : (
          <>
            {showToolbar ? (
              <SettingsListToolbar>
                <SettingsListSearch label="Search memory" value={query} onValueChange={setQuery} />
                {sortedLabels.length > 0 ? (
                  <SettingsListFilter
                    label="Project"
                    value={labelId}
                    onValueChange={setLabelId}
                    options={[
                      { value: ALL, label: "All projects" },
                      ...sortedLabels.map((label) => ({ value: label.id, label: label.name })),
                    ]}
                  />
                ) : null}
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
            ) : null}
            {list.error !== null ? (
              <SettingsRow title="Could not load memory" description={list.error} />
            ) : !list.isLoaded ? (
              <SettingsRow title="Loading memory…" role="status" />
            ) : facts.length === 0 ? (
              filtered ? (
                <SettingsListEmpty
                  icon={<BrainIcon />}
                  label="No memory matches these filters."
                  action={
                    <Button size="xs" variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              ) : list.facts.length > 0 ? (
                <SettingsListEmpty
                  icon={<BrainIcon />}
                  label="Everything here was forgotten or replaced."
                  action={
                    <Button size="xs" variant="outline" onClick={() => setStatus("all")}>
                      Show all
                    </Button>
                  }
                />
              ) : (
                <SettingsListEmpty
                  icon={<BrainIcon />}
                  label="Save what chats and agents should know."
                  action={rememberButton}
                />
              )
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

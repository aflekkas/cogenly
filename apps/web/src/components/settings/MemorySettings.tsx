import { OverlayPresence } from "~/components/ui/overlay-presence";
import type { AgentId, ProjectLabelId } from "@cogenly/contracts";
import { BrainIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAgents } from "../../agents/agentsClient";
import { FACT_STATUS_FILTERS, filterFacts, type FactStatusFilter } from "../../memory/facts.logic";
import { FactEditorDialog, FactList, factInputFromDraft } from "../../memory/FactList";
import { useFactActions, useFactNavigation, useFacts } from "../../memory/useFacts";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SearchInput } from "../ui/search-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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
  const actions = useFactActions(environmentId, list.refresh);
  const navigation = useFactNavigation(environmentId);
  const facts = useMemo(
    () => filterFacts(list.facts, { status, query }),
    [list.facts, query, status],
  );
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name;
  const filtered = labelId !== ALL || agentId !== ALL || status !== "current" || query !== "";

  return (
    <SettingsPageContainer>
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
          <SettingsRow title="Choose an environment to see what it remembers." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
              <SearchInput
                frameClassName="min-w-40 flex-1"
                aria-label="Search memory"
                placeholder="Search memory"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                clearLabel="Clear memory search"
                onClear={() => setQuery("")}
              />
              <Select value={labelId} onValueChange={(value) => setLabelId(value ?? ALL)}>
                <SelectTrigger size="sm" aria-label="Project">
                  <SelectValue>
                    {labelId === ALL
                      ? "All projects"
                      : (labels.find((label) => label.id === labelId)?.name ?? "Project")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>All projects</SelectItem>
                  {sortedLabels.map((label) => (
                    <SelectItem key={label.id} value={label.id}>
                      {label.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {agents.length > 0 ? (
                <Select value={agentId} onValueChange={(value) => setAgentId(value ?? ALL)}>
                  <SelectTrigger size="sm" aria-label="Agent">
                    <SelectValue>
                      {agentId === ALL ? "All agents" : (agentName(agentId) ?? "Agent")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={ALL}>All agents</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              <Select
                value={status}
                onValueChange={(value) =>
                  setStatus((value as FactStatusFilter | null) ?? "current")
                }
              >
                <SelectTrigger size="sm" aria-label="Status">
                  <SelectValue>
                    {FACT_STATUS_FILTERS.find((option) => option.value === status)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {FACT_STATUS_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {list.error !== null ? (
              <SettingsRow title="Could not load memory" description={list.error} />
            ) : !list.isLoaded ? (
              <SettingsRow title="Loading memory…" />
            ) : facts.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia>
                    <BrainIcon />
                  </EmptyMedia>
                  <EmptyTitle>{filtered ? "Nothing matches" : "Nothing remembered yet"}</EmptyTitle>
                  <EmptyDescription>
                    {filtered
                      ? "Try another project, agent or status."
                      : "Add something here. Agents can propose facts for you to confirm."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
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
      <OverlayPresence when={creating && environmentId}>
        {(environmentId) => (
          <FactEditorDialog
            title="Remember something"
            description="Saved as confirmed. You can correct or forget it later."
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
    </SettingsPageContainer>
  );
}

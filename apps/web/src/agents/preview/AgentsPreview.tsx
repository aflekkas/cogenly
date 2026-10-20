import { OverlayPresence } from "~/components/ui/overlay-presence";
import { useEffect, useState } from "react";
import { PlusIcon, MessageCircleIcon, HammerIcon } from "lucide-react";
import { AgentContacts } from "../AgentContacts";
import { AgentConversation } from "../AgentConversation";
import { CreateAgent } from "../AgentDetails";
import { AgentsClientProvider, useAgent, useAgents } from "../agentsClient";
import { agentContactKey } from "../agents.logic";
import { createMockAgentsClient } from "./mockAgents";
import "./preview.css";

export function AgentsPreview() {
  const [client] = useState(createMockAgentsClient);
  return (
    <AgentsClientProvider value={client}>
      <PreviewContent />
    </AgentsClientProvider>
  );
}
function PreviewContent() {
  const { agents } = useAgents();
  const [key, setKey] = useState<string | null>(() =>
    agents[0] ? agentContactKey(agents[0]) : null,
  );
  const [environmentId] = useState(() => agents[0]!.environmentId);
  const agent = useAgent(key);
  const [create, setCreate] = useState(false);
  const [mobileList, setMobileList] = useState(false);
  const [work, setWork] = useState<string | null>(null);
  useEffect(() => {
    const handler = (event: Event) => setWork((event as CustomEvent<string>).detail);
    window.addEventListener("agents-preview-work", handler);
    return () => window.removeEventListener("agents-preview-work", handler);
  }, []);
  return (
    <div data-agents-preview="shell">
      <aside data-agents-preview="sidebar" data-mobile-open={mobileList}>
        <div data-agents-preview="brand">
          <span data-agents-preview="mark">c</span>
          <span>Cogenly</span>
          <span data-agents-preview="person">A</span>
        </div>
        <div data-agents-preview="modes">
          <span>
            <MessageCircleIcon size={13} />
            Chats
          </span>
          <span>
            <HammerIcon size={13} />
            Work
          </span>
          <span data-selected="true">Agents</span>
        </div>
        <AgentContacts
          activeKey={key}
          onOpen={(contact) => {
            setKey(agentContactKey(contact));
            setMobileList(false);
          }}
          onCreate={() => setCreate(true)}
        />
        <div data-agents-preview="caption">A workspace that works with you.</div>
      </aside>
      <main data-mobile-hidden={mobileList}>
        {work ? (
          <div data-agents-preview="work">
            <button type="button" className="agent-text-button" onClick={() => setWork(null)}>
              ← Back to conversation
            </button>
            <h2>Nightly audit</h2>
            <span className="agent-muted">Mock work thread · {work}</span>
            <p>Auth suite: 38 passed. Three uses of the old helper found.</p>
            <pre>
              ✓ Inspect test helpers{`\n`}✓ Run auth suite{`\n`}✓ Send Juniper the highlights
            </pre>
          </div>
        ) : agent ? (
          <AgentConversation
            key={agentContactKey(agent)}
            agent={agent}
            onBack={() => setMobileList(true)}
          />
        ) : (
          <div className="agent-empty">
            <p>Make room for a little help.</p>
            <button className="agent-primary-button" type="button" onClick={() => setCreate(true)}>
              <PlusIcon size={15} />
              Create an agent
            </button>
          </div>
        )}
      </main>
      <OverlayPresence when={create}>
        {() => (
          <CreateAgent
            environmentId={environmentId}
            projectId={null}
            onClose={() => setCreate(false)}
            onCreated={(contact) => {
              setKey(agentContactKey(contact));
              setMobileList(false);
            }}
          />
        )}
      </OverlayPresence>
    </div>
  );
}

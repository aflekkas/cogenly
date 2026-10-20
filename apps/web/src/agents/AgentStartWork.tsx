import type { ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { randomUUID } from "~/lib/utils";
import { useAgentsClient } from "./agentsClient";
import { agentRepositoryAccess } from "./agentWorkspace.logic";
import type { AgentContact, AgentWorkspaceView } from "./agents.types";

/**
 * Start a normal Work session owned by this agent, in any repository. It runs in a
 * new worktree and appears in Work.
 * Starting it yourself is your approval, so it starts in any listed repository; each
 * one says whether the agent could start Work there on its own or would have to ask.
 * The server may still answer with a pending approval; that is said plainly.
 */
export function AgentStartWork({
  agent,
  workspace,
  onClose,
  onOpenItems,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onClose: () => void;
  onOpenItems: () => void;
}) {
  const client = useAgentsClient();
  const repositories = agentRepositoryAccess(agent, workspace.repositories);
  const [projectId, setProjectId] = useState<ProjectId | null>(repositories[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  // One launch identity per dialog, so a retried submit cannot start Work twice.
  const [commandId] = useState(() => `agent-start:${randomUUID()}`);
  const selected = repositories.find((repository) => repository.id === projectId);
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!projectId || !title.trim() || !prompt.trim()) return;
            setPending(true);
            setError(null);
            try {
              const result = await client.startWork(agent, {
                projectId,
                title: title.trim(),
                prompt: prompt.trim(),
                commandId,
              });
              if (result.threadId) {
                client.openWork(agent, result.threadId);
                onClose();
              } else if (result.approval) setAwaitingApproval(true);
              else setError("Work did not start, and no approval was requested.");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not start Work.");
            } finally {
              setPending(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Start Work with {agent.name}</DialogTitle>
            <DialogDescription>
              A coding session in a new worktree, owned by {agent.name}. It shows up in Work.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {awaitingApproval ? (
              <p className="text-sm text-foreground" role="status">
                This needs an approval before it starts. It is waiting in Open items.
              </p>
            ) : repositories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There are no repositories yet. Add a project first, or ask {agent.name} to add one.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  Repository
                  <Select
                    value={projectId ?? ""}
                    onValueChange={(value) =>
                      setProjectId(repositories.find((repo) => repo.id === value)?.id ?? null)
                    }
                  >
                    <SelectTrigger size="sm" aria-label="Repository">
                      <SelectValue>{selected?.title ?? "Choose a repository"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {repositories.map((repository) => (
                        <SelectItem
                          key={repository.id}
                          value={repository.id}
                          label={repository.title}
                        >
                          <span className="min-w-0 flex-1 truncate">{repository.title}</span>
                          <span className="text-2xs text-muted-foreground">
                            {[
                              repository.home ? "Home" : "",
                              repository.executable ? "" : "Asks you first",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {selected && (
                    <span className="font-normal">
                      {selected.executable
                        ? `${agent.name} may start Work here on its own too.`
                        : `On its own, ${agent.name} would ask you before starting Work here. Starting it yourself approves this one session; it doesn't change its permissions.`}
                    </span>
                  )}
                </div>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  Title
                  <Input
                    autoFocus
                    size="sm"
                    required
                    maxLength={200}
                    placeholder="Fix broken booking path checks"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  What should it do
                  <Textarea
                    required
                    rows={5}
                    maxLength={32000}
                    placeholder="Scope, constraints, and how you'll know it's done."
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>
              </div>
            )}
            {error && (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {awaitingApproval ? (
              <Button
                type="button"
                onClick={() => {
                  onOpenItems();
                  onClose();
                }}
              >
                See Open items
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={pending || !canWrite || !projectId || !title.trim() || !prompt.trim()}
                >
                  {pending ? "Starting…" : "Start Work"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

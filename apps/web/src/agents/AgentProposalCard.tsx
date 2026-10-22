import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import {
  FlagIcon,
  FolderIcon,
  PlugIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";
import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { WorkLogCollapse } from "~/components/chat/WorkLog";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import { canCreateProposal, scheduleInWords, type AgentProposal } from "./agentBuilder.logic";
import { AgentProjectPicker, useAgentProjectFolders } from "./AgentProjectPicker";
import { PERMISSION_OPTIONS } from "./agentWorkspace.logic";

/** Swaps its text with a short rise-and-fade whenever the value changes. */
function Morph({ value, className }: { value: string; className?: string }) {
  return (
    <span key={value} className={cn("agent-morph", className)}>
      {value}
    </span>
  );
}

function Row({
  icon: Icon,
  label,
  present,
  children,
}: {
  icon: LucideIcon;
  label: string;
  present: boolean;
  children: ReactNode;
}) {
  return (
    <WorkLogCollapse open={present} appear>
      <div className="flex gap-3 px-4 py-2">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <div className="text-sm leading-snug text-foreground">{children}</div>
        </div>
      </div>
    </WorkLogCollapse>
  );
}

/**
 * The agent as the builder proposes it, assembling a field at a time while the reply
 * streams: the face first, then the name, responsibility, schedule, tools and model.
 * Fields morph in place when the owner asks for a change. The project it will be
 * filed in can be changed here before creating.
 */
export function AgentProposalCard({
  proposal,
  seed,
  modelName,
  project,
  creating,
  onCreate,
  ref,
}: {
  proposal: AgentProposal;
  seed: string;
  modelName: string | null;
  /** Where the agent will be filed; null until the builder thread exists. */
  project: {
    environmentId: EnvironmentId;
    value: ProjectLabelId | null;
    onChange: (projectFolderId: ProjectLabelId | null) => void;
  } | null;
  creating: boolean;
  onCreate: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  // The face plays its "created" entrance once, then idles.
  const [settled, setSettled] = useState(false);
  const creatable = canCreateProposal(proposal);
  const grants = PERMISSION_OPTIONS.filter((option) =>
    proposal.permissions.includes(option.key),
  ).map((option) => option.label);
  return (
    <div
      ref={ref}
      className="agent-enter relative flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-xs"
      data-testid="agent-proposal-card"
      aria-live="polite"
      aria-label="Proposed agent"
    >
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <AgentFace
          {...avatarFaceProps({ seed, ...proposal.face })}
          state={settled ? "idle" : "created"}
          onSettled={() => setSettled(true)}
          size={48}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-semibold tracking-tight">
            {proposal.name ? (
              <Morph value={proposal.name} />
            ) : (
              <span className="text-muted-foreground/60">Thinking of a name…</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">New agent</span>
        </div>
      </div>

      <div className="flex flex-col border-t border-border/60 py-1">
        <Row icon={FlagIcon} label="Responsibility" present={Boolean(proposal.responsibility)}>
          <Morph value={proposal.responsibility ?? ""} />
        </Row>
        <Row icon={ZapIcon} label="Runs" present={proposal.triggers.length > 0}>
          <ul className="flex flex-col gap-1">
            {proposal.triggers.map((trigger) => (
              <li key={`${trigger.when}::${trigger.title}`} className="flex min-w-0 flex-col">
                <Morph
                  value={trigger.schedule ? scheduleInWords(trigger.schedule) : trigger.when}
                />
                {trigger.title && (
                  <Morph value={trigger.title} className="text-xs text-muted-foreground" />
                )}
              </li>
            ))}
          </ul>
        </Row>
        <Row icon={PlugIcon} label="Needs" present={proposal.needs.length > 0}>
          <ul className="flex flex-wrap gap-1.5">
            {proposal.needs.map((need) => (
              <li
                key={need}
                className="agent-morph rounded-md border border-border/60 px-1.5 py-0.5 text-xs"
              >
                {need}
              </li>
            ))}
          </ul>
        </Row>
        <Row icon={ShieldCheckIcon} label="Can also" present={grants.length > 0}>
          <Morph value={grants.join(", ")} />
        </Row>
        <Row icon={FolderIcon} label="Project" present={project !== null && creatable}>
          {project ? <ProposalProject {...project} disabled={creating} /> : null}
        </Row>
        <Row icon={SparklesIcon} label="Model" present={modelName !== null && creatable}>
          <Morph value={modelName ?? ""} />
          <span className="text-xs text-muted-foreground">
            {" "}
            · your default, changeable in its chat
          </span>
        </Row>
      </div>

      <WorkLogCollapse open={creatable && proposal.complete} appear>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-3">
          <Button variant="pixel" size="sm" disabled={creating} onClick={onCreate}>
            {creating ? "Creating…" : `Create ${proposal.name ?? "agent"}`}
          </Button>
          <span className="text-xs text-muted-foreground">or keep talking to adjust it</span>
        </div>
      </WorkLogCollapse>
    </div>
  );
}

/** The card's project, a picker the owner can change before creating. */
function ProposalProject(props: {
  environmentId: EnvironmentId;
  value: ProjectLabelId | null;
  onChange: (projectFolderId: ProjectLabelId | null) => void;
  disabled: boolean;
}) {
  const { current } = useAgentProjectFolders(props.environmentId, props.value);
  return (
    <div className="-mx-2 flex">
      <AgentProjectPicker
        environmentId={props.environmentId}
        value={props.value}
        onChange={props.onChange}
        disabled={props.disabled}
        aria-label={current ? `Project: ${current.label.name}. Change` : "No project. Change"}
        trigger={<Button type="button" variant="ghost-muted" size="xs" />}
      >
        <span key={current?.key ?? "none"} className="swap-motion flex min-w-0 items-center gap-1">
          {current ? <ProjectFolderIcon color={current.label.color} className="size-3.5" /> : null}
          <span className="min-w-0 truncate">{current ? current.label.name : "No project"}</span>
        </span>
      </AgentProjectPicker>
    </div>
  );
}

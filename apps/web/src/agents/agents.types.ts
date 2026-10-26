import type {
  AgentActivityResult,
  AgentApproval,
  AgentListItem,
  Commitment,
  CommitmentHistory,
  EnvironmentId,
  ProjectId,
  ProjectLabelWithRepositories,
  ModelSelection,
  RunId,
  ScheduledTaskSchedule,
  ScheduledTaskRunStatus,
  ThreadId,
} from "@cogenly/contracts";
import type { AgentFaceState } from "~/components/agents/face";
import type { ChatAttachment } from "~/types";

export type {
  AgentUpsertInput as AgentDraft,
  AgentMemoryNote as AgentMemory,
  AgentWorkRun as AgentActivity,
} from "@cogenly/contracts";
import type { AgentMemoryNote, AgentWorkRun } from "@cogenly/contracts";
export interface AgentTrigger {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  lastRunStatus?: ScheduledTaskRunStatus;
}
export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Images and files sent with an owner text; an optimistic send carries local previews. */
  attachments?: ReadonlyArray<ChatAttachment>;
  createdAt: string;
  updatedAt?: string;
  streaming?: boolean;
  optimistic?: boolean;
  delivery?: "sending" | "delivered" | "queued" | "read" | "failed" | "interrupted";
  source?: { name: string; threadId: ThreadId };
  /** The model an owner text went to; drives the "Switched to …" lines. */
  model?: AgentModelRef;
  /** The run that wrote an assistant reply; what retrieval added to it is shown per run. */
  runId?: RunId;
}
export type AgentModelRef = Pick<ModelSelection, "instanceId" | "model">;
/** The environment takes uploads with agent texts; `maxFileBytes` null means images only. */
export interface AgentAttachmentSupport {
  maxFileBytes: number | null;
}
export interface AgentRequest {
  id: string;
  threadId?: ThreadId;
  kind: "approval" | "question";
  text: string;
  createdAt: string;
  canRespond: boolean;
  questions?: ReadonlyArray<{
    id: string;
    text: string;
    options?: ReadonlyArray<{ label: string; value?: string; description?: string }>;
    required?: boolean;
    initialAnswer?: string;
    allowCustomAnswer?: boolean;
    multiSelect?: boolean;
  }>;
  choices?: ReadonlyArray<{
    label: string;
    decision: import("@cogenly/contracts").ProviderApprovalDecision;
  }>;
}
export interface AgentContact extends AgentListItem {
  environmentId: EnvironmentId;
  ownerName?: string | undefined;
  ownerOnline?: boolean;
  state: AgentFaceState;
  messages: ReadonlyArray<AgentMessage>;
  hasMoreMessages?: boolean;
  loadingEarlierMessages?: boolean;
  historyError?: string | null;
  conversationError?: string | null;
  preview: string;
  triggers: ReadonlyArray<AgentTrigger>;
  memory: ReadonlyArray<AgentMemoryNote>;
  activity: ReadonlyArray<AgentWorkRun>;
  requests: ReadonlyArray<AgentRequest>;
  /** Pending owner decisions the agent asked for: Work, a trigger, or a permission change. */
  approvals: ReadonlyArray<AgentApproval>;
  /** A run in its conversation or Work waits on an approval or answer, known before `requests` load. */
  waitingInRun?: boolean;
  /** What the agent is doing right now, from its running tool call, for the typing hint. */
  workingOn?: string | null;
  /** Its slot in the user-arranged Agents list: its conversation thread's active order key. */
  orderKey?: string | null;
  /** Its conversation can take an order key (not pinned, settled or archived). */
  orderable?: boolean;
}
/** What the agent's Details sheet reads: open items, activity, projects. */
export interface AgentWorkspaceView {
  commitments: ReadonlyArray<Commitment>;
  activity: typeof AgentActivityResult.Type | null;
  /** The environment's projects (labels) with their linked repositories. */
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
  /** The environment's repositories (Cogenly projects). */
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}
/** An open item's status history, loaded when someone expands it. */
export interface CommitmentHistoryView {
  history: ReadonlyArray<CommitmentHistory> | null;
  error: string | null;
}
export interface AgentModelOption {
  environmentId?: EnvironmentId;
  label: string;
  /** The model's own display name, e.g. "Claude Opus 5.5". */
  name?: string;
  selection: ModelSelection;
}
/** The live catalog's model and effort pickers, provided by the client boundary. */
export interface AgentModelControlsProps {
  agent: AgentContact;
  selection: ModelSelection;
  disabled: boolean;
  /** The saved model is missing from the catalog or its provider is off. */
  unavailable: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onChange: (selection: ModelSelection) => void;
}

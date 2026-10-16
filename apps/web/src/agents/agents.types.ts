import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ScheduledTaskSchedule,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentFaceState } from "~/components/agents/face";

// TODO(agents-core): replace these boundary types with Agent, AgentUpsertInput,
// AgentMemoryNote and AgentWorkRun imports after feat/agents-core is integrated.
export interface AgentRecord {
  id: string;
  name: string;
  avatar: { seed: string; color?: string };
  instructions: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  projectId: ProjectId | null;
  enabled: boolean;
  dailyRunCap: number;
  conversationThreadId: ThreadId;
  createdAt: string;
  updatedAt: string;
  consecutiveFailures: number;
  backoffUntil: string | null;
  pauseReason: string | null;
}
export type AgentDraft = Omit<
  AgentRecord,
  | "id"
  | "conversationThreadId"
  | "createdAt"
  | "updatedAt"
  | "consecutiveFailures"
  | "backoffUntil"
  | "pauseReason"
> & { id?: string };
export interface AgentMemory {
  id: string;
  agentId: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentActivity {
  id: string;
  agentId: string;
  triggerId: string;
  workThreadId: ThreadId;
  status: "starting" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  summary: string | null;
  posted: boolean;
}
export interface AgentTrigger {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
}
export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  streaming?: boolean;
  delivery?: "delivered" | "queued" | "read";
  source?: { name: string; threadId: ThreadId };
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
    decision: import("@t3tools/contracts").ProviderApprovalDecision;
  }>;
}
export interface AgentContact extends AgentRecord {
  environmentId: EnvironmentId;
  state: AgentFaceState;
  messages: ReadonlyArray<AgentMessage>;
  hasMoreMessages?: boolean;
  loadingEarlierMessages?: boolean;
  historyError?: string | null;
  conversationError?: string | null;
  preview: string;
  triggers: ReadonlyArray<AgentTrigger>;
  memory: ReadonlyArray<AgentMemory>;
  activity: ReadonlyArray<AgentActivity>;
  requests: ReadonlyArray<AgentRequest>;
}
export interface AgentModelOption {
  environmentId?: EnvironmentId;
  label: string;
  selection: ModelSelection;
}

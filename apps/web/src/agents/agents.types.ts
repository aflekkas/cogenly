import type {
  AgentListItem,
  EnvironmentId,
  ModelSelection,
  ScheduledTaskSchedule,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentFaceState } from "~/components/agents/face";

export type {
  AgentUpsertInput as AgentDraft,
  AgentMemoryNote as AgentMemory,
  AgentWorkRun as AgentActivity,
} from "@t3tools/contracts";
import type { AgentMemoryNote, AgentWorkRun } from "@t3tools/contracts";
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
  updatedAt?: string;
  streaming?: boolean;
  optimistic?: boolean;
  delivery?: "sending" | "delivered" | "queued" | "read" | "failed" | "interrupted";
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
export interface AgentContact extends AgentListItem {
  environmentId: EnvironmentId;
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
}
export interface AgentModelOption {
  environmentId?: EnvironmentId;
  label: string;
  selection: ModelSelection;
}

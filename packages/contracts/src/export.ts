import * as Schema from "effect/Schema";
import { ProjectLabelId } from "./projectLabel.ts";

export const ExportSection = Schema.Literals([
  "chats",
  "work",
  "agents",
  "commitments",
  "projects",
  "memory",
]);
export const ExportCreateInput = Schema.Struct({
  include: Schema.Array(ExportSection),
  labelId: Schema.optional(ProjectLabelId),
});
export type ExportCreateInput = typeof ExportCreateInput.Type;
export const ExportPathInput = Schema.Struct({ path: Schema.String });
export const ExportCounts = Schema.Record(Schema.String, Schema.Number);
export const ExportResult = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  counts: ExportCounts,
});
export type ExportResult = typeof ExportResult.Type;
export const ExportValidation = Schema.Struct({
  counts: ExportCounts,
  errors: Schema.Array(Schema.String),
});
export type ExportValidation = typeof ExportValidation.Type;
export const ExportManifest = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  format: Schema.Literal("cogenly-jsonl"),
  createdAt: Schema.String,
  include: Schema.Array(ExportSection),
  labelId: Schema.optional(ProjectLabelId),
  counts: ExportCounts,
  contentBytes: Schema.Number,
});
export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not access the portable export.";
  }
}

/** V1/V2 portable rows. JSON columns are UTF-8 JSON strings, validated without executing them. */
export const ExportRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("threads"),
    data: Schema.Struct({
      thread_id: Schema.String,
      project_id: Schema.String,
      title: Schema.String,
      default_provider: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
      repository_root: Schema.NullOr(Schema.String),
      branch: Schema.NullOr(Schema.String),
      worktree_path: Schema.NullOr(Schema.String),
      work_origin: Schema.NullOr(Schema.String),
      source_thread_id: Schema.NullOr(Schema.String),
      source_agent_id: Schema.NullOr(Schema.String),
      source_agent_run_id: Schema.NullOr(Schema.String),
      model_selection: Schema.NullOr(Schema.String),
      pull_requests: Schema.NullOr(Schema.String),
      linked_pull_request: Schema.NullOr(Schema.String),
      branch_pull_request: Schema.NullOr(Schema.String),
      status: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("messages"),
    data: Schema.Struct({
      message_id: Schema.String,
      thread_id: Schema.String,
      run_id: Schema.NullOr(Schema.String),
      role: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
      text: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("runs"),
    data: Schema.Struct({
      run_id: Schema.String,
      thread_id: Schema.String,
      provider: Schema.String,
      provider_instance_id: Schema.NullOr(Schema.String),
      status: Schema.String,
      requested_at: Schema.String,
      completed_at: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      model_selection: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("agents"),
    data: Schema.Struct({
      agent_id: Schema.String,
      conversation_thread_id: Schema.String,
      payload_json: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("triggers"),
    data: Schema.Struct({
      task_id: Schema.String,
      agent_id: Schema.String,
      title: Schema.String,
      prompt: Schema.String,
      enabled: Schema.Number,
      schedule_json: Schema.String,
      project_id: Schema.String,
      thread_id: Schema.NullOr(Schema.String),
      model_selection_json: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("agentRuns"),
    data: Schema.Struct({
      run_id: Schema.String,
      agent_id: Schema.String,
      trigger_id: Schema.String,
      work_thread_id: Schema.String,
      status: Schema.String,
      created_at: Schema.String,
      completed_at: Schema.NullOr(Schema.String),
      summary: Schema.NullOr(Schema.String),
      trigger_kind: Schema.optional(Schema.String),
      trigger_context_json: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("agentRunThreads"),
    data: Schema.Struct({
      thread_id: Schema.String,
      agent_id: Schema.String,
      trigger_kind: Schema.String,
      source_run_id: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("actions"),
    data: Schema.Struct({
      id: Schema.String,
      agent_id: Schema.String,
      run_id: Schema.NullOr(Schema.String),
      kind: Schema.String,
      target_id: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("approvals"),
    data: Schema.Struct({
      id: Schema.String,
      agent_id: Schema.String,
      action_json: Schema.String,
      status: Schema.String,
      requested_at: Schema.String,
      decided_at: Schema.NullOr(Schema.String),
      decided_by: Schema.NullOr(Schema.String),
      source_run_id: Schema.NullOr(Schema.String),
      result_thread_id: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("memory"),
    data: Schema.Struct({
      note_id: Schema.String,
      agent_id: Schema.String,
      text: Schema.String,
      source: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("memory"),
    data: Schema.Struct({
      id: Schema.String,
      agent_id: Schema.NullOr(Schema.String),
      legacy_note_id: Schema.NullOr(Schema.String),
      legacy_source: Schema.NullOr(Schema.String),
      status: Schema.String,
      payload_json: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("factHistory"),
    data: Schema.Struct({
      sequence: Schema.String,
      fact_id: Schema.String,
      payload_json: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("contextRefs"),
    data: Schema.Struct({
      run_id: Schema.String,
      thread_id: Schema.String,
      payload_json: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("eventDeliveries"),
    data: Schema.Struct({
      agent_id: Schema.String,
      event_key: Schema.String,
      work_thread_id: Schema.String,
      context_json: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("commitments"),
    data: Schema.Struct({
      id: Schema.String,
      agent_id: Schema.NullOr(Schema.String),
      status: Schema.String,
      payload_json: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("commitmentHistory"),
    data: Schema.Struct({
      id: Schema.String,
      commitment_id: Schema.String,
      payload_json: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("labels"),
    data: Schema.Struct({
      label_id: Schema.String,
      name: Schema.String,
      color: Schema.NullOr(Schema.String),
      description: Schema.NullOr(Schema.String),
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    data: Schema.Struct({
      project_id: Schema.String,
      title: Schema.String,
      workspace_root: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("repositoryLabels"),
    data: Schema.Struct({
      label_id: Schema.String,
      repository_id: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("threadLabels"),
    data: Schema.Struct({
      thread_id: Schema.String,
      label_id: Schema.String,
      confidence: Schema.NullOr(Schema.Number),
      confirmed_by_user: Schema.Number,
      source: Schema.String,
    }),
  }),
]);

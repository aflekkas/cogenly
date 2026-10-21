import { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AgentBuilder } from "../agents/AgentBuilder";

function NewAgentRoute() {
  const { environmentId, projectFolderId } = Route.useSearch();
  return (
    <AgentBuilder
      {...(environmentId ? { environmentId } : {})}
      {...(projectFolderId ? { projectFolderId } : {})}
    />
  );
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Creating an agent happens here, in a conversation; see `AgentBuilder`. A
 * project folder (on the given environment) files the builder and its agent there.
 */
export const Route = createFileRoute("/_chat/agents/new")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { environmentId?: EnvironmentId; projectFolderId?: ProjectLabelId } =>
    nonEmpty(raw.environmentId)
      ? {
          environmentId: EnvironmentId.make(raw.environmentId),
          ...(nonEmpty(raw.projectFolderId)
            ? { projectFolderId: ProjectLabelId.make(raw.projectFolderId) }
            : {}),
        }
      : {},
  component: NewAgentRoute,
});

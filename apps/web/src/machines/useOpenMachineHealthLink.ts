import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { openProviderSignIn } from "../components/providers/ProviderSignInDialog";
import { machineHealthAnchorId, type MachineHealthLink } from "./machineHealthLinks.logic";

/** Navigates to the screen a health item or alert points at, or opens a provider's sign-in. */
export function useOpenMachineHealthLink(): (link: MachineHealthLink) => void {
  const navigate = useNavigate();
  return useCallback(
    (link: MachineHealthLink) => {
      switch (link.kind) {
        case "storage":
          void navigate({ to: "/settings/storage", search: { machine: link.environmentId } });
          return;
        case "thread":
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: link.environmentId, threadId: link.threadId },
          });
          return;
        case "scheduledTask":
          void navigate({
            to: "/settings/scheduled-tasks",
            search: { environmentId: link.environmentId, taskId: link.taskId },
          });
          return;
        case "provider":
          void navigate({
            to: "/settings/providers",
            search: { environmentId: link.environmentId, instanceId: link.instanceId },
          });
          return;
        case "providerSignIn":
          void openProviderSignIn({
            environmentId: link.environmentId,
            targetEnvironmentId: link.targetEnvironmentId,
            instanceId: link.instanceId,
          });
          return;
        case "integrations":
          void navigate({
            to: "/settings/integrations",
            search: { machine: link.environmentId },
            hash: "integration-services",
          });
          return;
        case "machineHealth":
          void navigate({
            to: "/settings/machines",
            search: { machine: link.viewedEnvironmentId },
            hash: machineHealthAnchorId(link.machineEnvironmentId),
          });
          return;
      }
    },
    [navigate],
  );
}

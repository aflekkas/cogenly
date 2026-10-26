import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type ProjectScript,
} from "@cogenly/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  releaseClaimedRoles,
} from "../../projectScripts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { NewProjectScriptInput } from "../projectScriptEditor";
import { toastManager } from "../ui/toast";

function reportScriptFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Failed to save repository actions",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return mapAtomCommandResult(result, () => undefined);
}

function deniedResult(message: string): AtomCommandResult<void, unknown> {
  return reportScriptFailure(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentAuthorizationError({ requiredScope: AuthSettingsWriteScope, message }),
      ),
    ),
  );
}

/**
 * Edits a repository's actions, stored on each of its checkouts
 * (`Project.scripts`), then saves changed shortcuts once per machine. A
 * checkout without its own list starts from the machine's actions.
 */
export function useProjectScriptSettings(members: readonly SidebarProjectGroupMember[]) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(
    serverEnvironment.upsertKeybinding,
    "action shortcut update",
  );
  const removeKeybinding = useAtomCommand(
    serverEnvironment.removeKeybinding,
    "action shortcut removal",
  );
  const configOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig ??
    null;

  async function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[],
    scriptId?: string,
    keybinding?: string | null,
  ): Promise<AtomCommandResult<void, unknown>> {
    const targets = members.flatMap((member) => {
      const config = configOf(member.environmentId);
      return config ? [{ member, config }] : [];
    });
    if (savingRef.current || targets.length === 0 || targets.length < members.length) {
      const message =
        "Connect every machine with this repository, or wait for the last change to save.";
      toastManager.add({ type: "error", title: "Actions not saved", description: message });
      return AsyncResult.failure(Cause.fail(new Error(message)));
    }
    // A project update carrying scripts also needs settings permission.
    const denied = targets.find(
      ({ member }) =>
        !readEnvironmentScope(member.environmentId, AuthSettingsWriteScope) ||
        !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
    );
    if (denied) {
      return deniedResult(
        `This connection cannot change actions on ${denied.member.environmentLabel ?? "this machine"}.`,
      );
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const handledEnvironments = new Set<EnvironmentId>();
      for (const { member, config } of targets) {
        const current = member.scripts;
        const nextScripts = transform(current);
        const result = await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, scripts: [...nextScripts] },
        });
        if (result._tag === "Failure") return reportScriptFailure(result);
        // Shortcuts are per machine, so each machine's bindings change once.
        if (handledEnvironments.has(member.environmentId)) continue;
        handledEnvironments.add(member.environmentId);
        const changedIds = scriptId
          ? [scriptId]
          : current
              .filter((script) => !nextScripts.some((next) => next.id === script.id))
              .map((script) => script.id);
        for (const id of changedIds) {
          const command = commandForProjectScript(id);
          const previousValue = keybindingValueForCommand(config.keybindings, command);
          const previous = previousValue
            ? decodeProjectScriptKeybindingRule({ keybinding: previousValue, command })
            : null;
          const next = decodeProjectScriptKeybindingRule({ keybinding, command });
          const retainedElsewhere =
            !nextScripts.some((script) => script.id === id) &&
            projects.some(
              (other) =>
                other.environmentId === member.environmentId &&
                !members.some((candidate) => candidate.id === other.id) &&
                other.scripts.some((script) => script.id === id),
            );
          const bindingResult = next
            ? await upsertKeybinding({
                environmentId: member.environmentId,
                input:
                  previous && previous.key !== next.key ? { ...next, replace: previous } : next,
              })
            : previous && !retainedElsewhere
              ? await removeKeybinding({ environmentId: member.environmentId, input: previous })
              : null;
          if (bindingResult?._tag === "Failure") return reportScriptFailure(bindingResult);
        }
      }
      return AsyncResult.success(undefined);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function submit(scriptId: string | null, input: NewProjectScriptInput) {
    const existingIds = projects.flatMap((project) => {
      return project.scripts.map((script) => script.id);
    });
    const id = scriptId ?? nextProjectScriptId(input.name, existingIds);
    const next = buildProjectScript(id, input);
    return persist(
      (current) => {
        const updated = current.map((script) =>
          script.id === id ? next : releaseClaimedRoles(script, input),
        );
        return scriptId === null ? [...updated, next] : updated;
      },
      id,
      input.keybinding,
    );
  }

  return { saving, persist, submit };
}

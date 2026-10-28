import { integrationCatalogEntryFor, type EnvironmentId } from "@cogenly/contracts";
import type { SecretRequestItem } from "@cogenly/client-runtime/secret-request";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { integrationsRpc } from "../../rpc/integrations";
import { machinesRpc } from "../../rpc/machines";
import { useEnvironmentQuery } from "../../state/query";

/** Subscribe to each paired destination, including the next machine that needs consent. */
export function useIntegrationSetupMachines(
  environmentId: EnvironmentId,
  target: SecretRequestItem["integrationSetup"],
) {
  const id = target?.integrationId;
  const catalogId = target?.setup?.catalogId;
  const accountLabel = target?.accountLabel;
  const atom = useMemo(
    () =>
      Atom.make((get) => {
        const registry = Option.getOrNull(
          AsyncResult.value(get(machinesRpc.list({ environmentId, input: {} }))),
        );
        const machines = registry?.machines.filter((machine) => machine.pairing !== "revoked") ?? [
          { environmentId, name: "this machine", online: true },
        ];
        return AsyncResult.success({
          ready: registry !== null,
          machines: machines.map((machine) => {
            const list = get(
              integrationsRpc.list({ environmentId: machine.environmentId, input: {} }),
            );
            const summary = Option.getOrNull(AsyncResult.value(list))?.integrations.find(
              (summary) =>
                id
                  ? summary.integration.id === id
                  : integrationCatalogEntryFor(summary.integration)?.id === catalogId &&
                    summary.integration.accountLabel === accountLabel,
            );
            return {
              environmentId: machine.environmentId,
              name: machine.name,
              summary,
              status: !machine.online
                ? "offline"
                : (summary?.status ?? (list._tag === "Failure" ? "unavailable" : "syncing")),
            };
          }),
        });
      }),
    [environmentId, id, catalogId, accountLabel],
  );
  return useEnvironmentQuery(atom);
}

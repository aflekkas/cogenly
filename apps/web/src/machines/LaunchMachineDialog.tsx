import type { EnvironmentId } from "@cogenly/contracts";
import { useEffect } from "react";
import { create } from "zustand";
import {
  Select,
  SelectTrigger,
  SelectPopup,
  SelectValue,
  SelectItem,
} from "../components/ui/select";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import { EnvironmentOptionContent } from "../components/BranchToolbarEnvironmentSelector";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { machineIconKind } from "./machines.logic";

type Request = {
  readonly preferHub: boolean;
  readonly environmentId: EnvironmentId;
  readonly resolve: (machine: EnvironmentId | null) => void;
};
const useChoice = create<{
  request: Request | null;
  open: boolean;
  selected: EnvironmentId | null;
}>(() => ({ request: null, open: false, selected: null }));
const queue: Request[] = [];
const next = () => {
  const request = queue.shift() ?? null;
  useChoice.setState({ request, open: request !== null, selected: null });
};

/** Shared by Start Work's picker, message actions, command palette, and keybindings. */
export function requestLaunchMachine(
  environmentId: EnvironmentId,
  preferHub = false,
): Promise<EnvironmentId | null> {
  return new Promise((resolve) => {
    const request = { environmentId, resolve, preferHub };
    if (useChoice.getState().request !== null) queue.push(request);
    else useChoice.setState({ request, open: true, selected: null });
  });
}

export function LaunchMachineDialog() {
  const { request, open, selected } = useChoice();
  const query = useEnvironmentQuery(
    request === null
      ? null
      : serverEnvironment.machinesLive({ environmentId: request.environmentId, input: {} }),
  );
  const machines = query.data?.machines.filter((machine) => machine.pairing !== "revoked") ?? [];
  const picked =
    selected ??
    (request?.preferHub
      ? machines.find((machine) => machine.relation === "hub")?.environmentId
      : undefined) ??
    request?.environmentId ??
    null;
  const choose = (machine: EnvironmentId | null) => {
    if (!open || request === null) return;
    request.resolve(machine);
    useChoice.setState({ open: false });
  };
  useEffect(() => {
    if (!open || request === null) return;
    // Older servers and a machine with no peers preserve the one-click launch.
    if (query.error !== null || (query.data !== null && machines.length < 2)) {
      request.resolve(request.environmentId);
      useChoice.setState({ request: null, open: false });
      if (queue.length > 0) next();
    }
  }, [open, request, query.error, query.data, machines.length]);
  return (
    <Dialog
      open={open && machines.length > 1}
      onOpenChange={(value) => {
        if (!value) choose(null);
      }}
      onOpenChangeComplete={(value) => {
        if (!value) next();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Run on</DialogTitle>
          <DialogDescription>Choose the machine that runs this work.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select
            value={picked}
            onValueChange={(value) => {
              const machine = machines.find((machine) => machine.environmentId === value);
              if (machine) useChoice.setState({ selected: machine.environmentId });
            }}
          >
            <SelectTrigger aria-label="Runs on">
              <SelectValue>
                {machines.find((machine) => machine.environmentId === picked)?.name ??
                  "This machine"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {machines.map((machine) => (
                <SelectItem
                  key={machine.environmentId}
                  value={machine.environmentId}
                  label={machine.name}
                >
                  <EnvironmentOptionContent
                    option={{
                      environmentId: machine.environmentId,
                      projectId: null,
                      label: machine.name,
                      isPrimary: machine.relation === "this",
                      machine: machineIconKind(machine),
                      pairedMachine: { online: machine.online },
                    }}
                  />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => choose(null)}>
            Cancel
          </Button>
          <Button onClick={() => choose(picked)}>Start</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

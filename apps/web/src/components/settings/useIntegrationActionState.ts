import { useState } from "react";
import { settleIntegrationAction, type IntegrationActionState } from "./integrationServices.logic";

export function useIntegrationActionState() {
  const [state, setState] = useState<IntegrationActionState>({ type: "idle" });
  return {
    state,
    pending: state.type === "pending",
    error: state.type === "error" ? state.message : null,
    begin: (purpose: "sign_in" | "change" = "sign_in") => setState({ type: "pending", purpose }),
    fail: (message: string) => setState({ type: "error", message }),
    settle: () => setState(settleIntegrationAction),
  };
}

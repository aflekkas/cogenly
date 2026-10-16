import type { ModelSelection, OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";

export interface ProviderSelectionTransitionInput {
  readonly current: ModelSelection;
  readonly target: ModelSelection;
  readonly sessionCapabilities: OrchestrationV2ProviderCapabilities;
}

/**
 * Provider-owned classification of how a complete selection can be applied.
 * The orchestrator remains responsible for attempts and resource lifecycle.
 */
export type ProviderSelectionTransitionPlan =
  | { readonly type: "apply_on_next_turn" }
  | { readonly type: "restart_session" }
  | { readonly type: "create_with_handoff" }
  | { readonly type: "reject"; readonly reason: string };

export function turnScopedSelectionTransition(): ProviderSelectionTransitionPlan {
  return { type: "apply_on_next_turn" };
}

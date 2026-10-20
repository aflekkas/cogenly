import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";

import * as VisualStates from "../htmlRender/VisualState.ts";
import { layerProduction } from "./runtimeLayer.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type ProductionRequirements = Layer.Services<typeof layerProduction>;
type ProductionOutputs = Layer.Success<typeof layerProduction>;

// The production layer builds thread management itself. Demanding it as an
// input leaks the requirement into every CLI command through runServer and
// breaks the server typecheck at binCli.ts.
type DemandsThreadManagement = Extract<
  ProductionRequirements,
  ThreadManagement.ThreadManagementService
>;

const demandsThreadManagement: [DemandsThreadManagement] extends [never] ? true : false = true;

// The visual state feature needs its service in the production scope (the
// websocket handlers read it there), so the fix must keep providing it.
type ProvidesVisualStates = Extract<ProductionOutputs, VisualStates.VisualStateService>;

const providesVisualStates: [ProvidesVisualStates] extends [never] ? false : true = true;

it("provides visual states without demanding thread management", () => {
  expect(demandsThreadManagement).toBe(true);
  expect(providesVisualStates).toBe(true);
});

import { ComputerUseUnavailableError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerScreenshotToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

/** The credential carries `computer` exactly when the owner left computer use on for this thread. */
const requireComputerAccess = McpInvocationContext.requireThreadMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new ComputerUseUnavailableError({
        code: "disabled",
        reason:
          "The owner turned computer use off on this machine. Do not work around it with osascript or other scripts. They can turn on Computer use in Settings → Integrations → Agent access; it applies when the agent session next starts.",
      }),
  ),
);

/** Each tool runs behind the access gate; the service checks macOS itself. */
const gated = <A>(effect: Effect.Effect<A, ComputerUseUnavailableError>) =>
  requireComputerAccess.pipe(Effect.andThen(effect));

const service = ComputerUseService.ComputerUse;

const handlers = {
  computer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const computer = yield* service;
      return yield* computer.status({
        enabled: scope.capabilities.has("computer"),
        tool: input?.tool,
      });
    }),
  ),
  computer_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.screenshot(input))),
  ),
  computer_apps: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(service, (computer) =>
      gated(computer.apps).pipe(
        Effect.map((result) => {
          const name = input?.name?.trim().toLowerCase();
          return name
            ? {
                ...result,
                apps: result.apps.filter((app) => app.name.toLowerCase().includes(name)),
              }
            : result;
        }),
      ),
    ),
  ),
  computer_ui: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.ui(input))),
  ),
  computer_open_app: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.openApp(input))),
  ),
  computer_press: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.press(input))),
  ),
  computer_click: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.click(input))),
  ),
  computer_type: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.type(input))),
  ),
  computer_key: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.key(input))),
  ),
  computer_scroll: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.scroll(input))),
  ),
  computer_drag: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, (computer) => gated(computer.drag(input))),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const { computer_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ComputerStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});

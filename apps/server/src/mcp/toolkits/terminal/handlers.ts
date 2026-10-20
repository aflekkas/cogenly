import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TerminalMcpService from "../../TerminalMcpService.ts";
import { TerminalToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(TerminalToolkit, {
  terminal_run: McpToolAccess.actsAsWorkCaller((input) =>
    Effect.flatMap(TerminalMcpService.TerminalMcpService, (service) => service.run(input)),
  ),
  terminal_read: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(TerminalMcpService.TerminalMcpService, (service) => service.read(input)),
  ),
  terminal_write: McpToolAccess.actsAsWorkCaller((input) =>
    Effect.flatMap(TerminalMcpService.TerminalMcpService, (service) => service.write(input)),
  ),
  terminal_kill: McpToolAccess.actsAsWorkCaller((input) =>
    Effect.flatMap(TerminalMcpService.TerminalMcpService, (service) => service.kill(input)),
  ),
  terminal_list: McpToolAccess.readsAsCaller(() =>
    Effect.flatMap(TerminalMcpService.TerminalMcpService, (service) =>
      service.list().pipe(Effect.map((terminals) => ({ terminals }))),
    ),
  ),
});

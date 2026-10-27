import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  TerminalSessionStatus,
  TerminalSummary,
  TrimmedNonEmptyString,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as TerminalMcpService from "../../TerminalMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    TerminalMcpService.TerminalMcpService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const identity = { terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)) };
const result = Schema.Struct({
  terminalId: Schema.String,
  status: TerminalSessionStatus,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  output: Schema.String,
  nextOffset: NonNegativeInt,
  truncated: Schema.Boolean,
  notice: Schema.optional(Schema.String),
  /** Set when a chat's command ran in the read-only sandbox. */
  sandbox: Schema.optional(Schema.Literal("read-only")),
});
const run = Tool.make("terminal_run", {
  ...shared,
  description:
    "Run a visible thread-owned PTY (full-access/default). cwd defaults to workspace; escapes/symlinks outside it are refused. Foreground timeout defaults 120000ms, max 600000, then kills children. Use background for long/prompting commands; read/write/kill manage it. Output retains bounded head/tail. Stop/cancel/settle/archive/delete/idle reaping kills descendants, even detached ones. keepRunning:true (background only, user-requested servers) survives Stop/settle/idle, never archive/delete.",
  parameters: Schema.Struct({
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
    cwd: Schema.optional(TrimmedNonEmptyString),
    timeoutMs: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
    ),
    background: Schema.optional(Schema.Boolean),
    keepRunning: Schema.optional(Schema.Boolean),
  }),
  success: result,
});
const read = Tool.make("terminal_read", {
  ...shared,
  description:
    "Read bounded buffered PTY output; sinceOffset/nextOffset are absolute UTF-16 offsets. Dropped output is marked.",
  parameters: Schema.Struct({ ...identity, sinceOffset: Schema.optional(NonNegativeInt) }),
  success: result,
}).annotate(Tool.Readonly, true);
const write = Tool.make("terminal_write", {
  ...shared,
  description:
    "Send stdin to this thread's agent terminal, including newline or Ctrl-C as needed. Requires full-access/default mode.",
  parameters: Schema.Struct({
    ...identity,
    input: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  }),
  success: Schema.Struct({}),
});
const kill = Tool.make("terminal_kill", {
  ...shared,
  description:
    "Kill a thread PTY and all descendants, including detached children of exited/kept terminals. Buffered output stays readable.",
  parameters: Schema.Struct(identity),
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, true);
const list = Tool.make("terminal_list", {
  ...shared,
  description:
    "List only this thread's agent terminals, including retained finished terminals. keepRunning marks commands started to outlive stop and settle.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ terminals: Schema.Array(TerminalSummary) }),
}).annotate(Tool.Readonly, true);
export const TerminalToolkit = Toolkit.make(run, read, write, kill, list);

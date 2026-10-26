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
    "Run a shell command in a visible PTY owned by this thread (full-access/default mode required). Use this for all shell commands. cwd defaults to the thread workspace; cwd outside it, including symlink escapes, is rejected. Foreground waits up to timeoutMs (default 120000, max 600000), then kills the process tree. A command that may take more than about a minute, or may prompt (logins, cloud CLIs, installs, builds, test suites), runs with background=true and is polled with terminal_read, so the user's messages aren't blocked while it runs. background=true returns immediately for servers/watchers. Output retains a bounded head and tail with omitted-character markers. A command and every process it starts, including ones that detach, are killed when the user stops the thread, the task is cancelled, the thread settles, is archived or deleted, or the thread sits idle for hours. keepRunning=true (background only) keeps a server the user asked to leave up past stop, settle and idle reaping; archive and delete still kill it.",
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
    "Read buffered output of this thread's running or finished agent terminal. sinceOffset is an absolute UTF-16 character offset returned as nextOffset. Dropped output is marked explicitly.",
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
    "Kill this thread's agent terminal and every process it started, including ones that left its process group. Works on kept and already-exited terminals whose children still run. Keeps its output available for terminal_read.",
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

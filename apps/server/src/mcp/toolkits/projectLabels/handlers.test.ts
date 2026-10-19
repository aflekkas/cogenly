import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectLabelsToolkit } from "./tools.ts";

it.effect.each([
  { access: "read-only" as const, code: "capability_denied" },
  { access: "approval-required" as const, code: "runtime_mode_escalation_denied" },
  { access: "full-access" as const, code: undefined },
])("keeps the caller's $access limits when assigning shared context tags", ({ access, code }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("shared-context-thread");
    const labelId = ProjectLabelId.make("shared-label");
    const writes: Array<{ confirmedByUser: boolean }> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        capabilities: new Set(["orchestration" as const]),
        requestNamespace: "test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "session", label: "Agent", access },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(Labels.ProjectLabelService)({
        setThreadLabels: (input, confirmedByUser = true) =>
          Effect.sync(() => {
            writes.push({ confirmedByUser });
            return {
              labels: input.labelIds.map((labelId) => ({
                threadId: input.threadId,
                labelId,
                source: "user" as const,
                confidence: null,
                confirmedByUser,
              })),
            };
          }),
      }),
    );
    const toolkit = yield* ProjectLabelsToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const results = yield* toolkit
      .handle("t3_thread_set_project_labels", { threadId, labelIds: [labelId] })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    if (code) {
      expect(results.at(-1)?.result).toMatchObject({ code });
      expect(writes).toEqual([]);
    } else {
      expect(results.at(-1)?.result).toMatchObject({
        labels: [{ labelId, confirmedByUser: false }],
      });
      expect(writes).toEqual([{ confirmedByUser: false }]);
    }
  }),
);

import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { machinesTurnContext } from "../machines/machinesTurnContext.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect.each(["/compact", "/some-command"])(
  "preserves %s with two paired machines",
  (command) => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    let compactions = 0;
    provider.setStart((input) =>
      Effect.gen(function* () {
        const turn = yield* provider.begin(input);
        yield* provider.finish(input, turn);
      }),
    );
    provider.setCompact((input) =>
      Effect.gen(function* () {
        compactions++;
        const turn = yield* provider.begin(input);
        yield* provider.finish(input, turn);
      }),
    );
    const machinesContext = machinesTurnContext({
      machines: ["Mac", "VPS"].map((name, i) => ({
        environmentId: EnvironmentId.make(name),
        name,
        kind: i === 0 ? "this-computer" : "other-computer",
        hardware: "laptop",
        platform: "darwin",
        providers: [],
        relation: i === 0 ? "this" : "spoke",
        online: true,
        lastSeenAt: null,
        pairedAt: null,
        pairing: i === 0 ? "self" : "paired",
      })),
      link: { _tag: "hub", spokes: 1 },
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:slash-command");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:test"),
        title: "Slash command",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const [i, text] of ["Hello", command].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${i}`),
          threadId,
          messageId: MessageId.make(`message:${i}`),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
          Stream.filter(
            (row) =>
              row.event.type === "run.updated" &&
              row.event.payload.ordinal === i + 1 &&
              row.event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* worker.drain();
      }
      expect(provider.turns[0]?.message.text).toContain("<machines>");
      expect(provider.turns[1]?.message.text).toBe(command);
      expect(compactions).toBe(command === "/compact" ? 1 : 0);
    }).pipe(
      Effect.provide(
        layerWithRegistry({ name: "slash-command" }, provider.registry, {
          runEffectWorker: false,
          machinesContext,
        }),
      ),
    );
  },
);

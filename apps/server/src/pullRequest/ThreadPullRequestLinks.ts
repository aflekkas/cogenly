import {
  CommandId,
  type ThreadId,
  type ThreadPullRequestKey,
  type ThreadPullRequestLinkSource,
} from "@cogenly/contracts";
import {
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "@cogenly/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { shellCreatedPullRequest } from "./shellCreatedPullRequest.ts";

type Target = ThreadPullRequestKey & { readonly url: string };
export class ThreadPullRequestLinks extends Context.Service<
  ThreadPullRequestLinks,
  {
    readonly link: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly target: Target;
      readonly source: ThreadPullRequestLinkSource;
    }) => Effect.Effect<boolean, Orchestrator.OrchestratorV2Error>;
    readonly linkCreated: (input: {
      readonly threadId: ThreadId;
      readonly commandId: string;
      readonly command: string;
      readonly output: string;
    }) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  }
>()("cogenly-server/pullRequest/ThreadPullRequestLinks") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const link: ThreadPullRequestLinks["Service"]["link"] = Effect.fn("ThreadPullRequestLinks.link")(
    function* (input) {
      const thread = yield* engine.getThreadShell(input.threadId);
      const alreadyLinked =
        thread !== null &&
        threadPullRequestsOf(thread).some(
          (link) =>
            link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, input.target),
        );
      // Dispatch even an existing link so the stable command receipt survives a later user unlink.
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId: input.commandId,
        threadId: input.threadId,
        ...input.target,
        source: input.source,
      });
      return alreadyLinked;
    },
  );
  const linkCreated: ThreadPullRequestLinks["Service"]["linkCreated"] = Effect.fn(
    "ThreadPullRequestLinks.linkCreated",
  )(function* (input) {
    const target = shellCreatedPullRequest(input.command, input.output);
    if (!target) return;
    yield* link({
      threadId: input.threadId,
      commandId: CommandId.make(
        `server:pr-created-link:${input.threadId}:${input.commandId}:${threadPullRequestKeyOf(target)}`,
      ),
      target,
      source: "created",
    });
  });
  return ThreadPullRequestLinks.of({ link, linkCreated });
});
export const layer = Layer.effect(ThreadPullRequestLinks, make);

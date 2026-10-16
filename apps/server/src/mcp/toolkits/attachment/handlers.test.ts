import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AttachmentHandlers from "./handlers.ts";
import { AttachmentToolkit } from "./tools.ts";

it.effect("explains a disabled provider when sending attachments", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:attachment-disabled");
    const shell = liveThreadShell(threadId);
    const attachment = {
      type: "image" as const,
      id: "owned-image",
      name: "audit.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const projection: OrchestrationV2ThreadProjection = {
      ...idleThreadProjection(shell),
      messages: [
        {
          id: MessageId.make("message:attachment"),
          threadId,
          runId: null,
          nodeId: null,
          role: "user" as const,
          createdBy: "user",
          creationSource: "mcp",
          text: "",
          attachments: [attachment],
          streaming: false,
          createdAt: shell.createdAt,
          updatedAt: shell.updatedAt,
        },
      ],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:attachment"),
        requestNamespace: "session:attachment",
        thread: {
          threadId,
          providerSessionId: "session:attachment",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getProjectThreadRecords: () => Effect.succeed(projection),
        sendToThread: () =>
          Effect.fail(
            new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
              projectId: shell.projectId,
              instanceId: shell.providerInstanceId,
            }),
          ),
      }),
    );
    const toolkit = yield* AttachmentToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AttachmentHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_send_attachments", { attachments: [attachment] })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining('Provider instance "codex" is disabled'),
    });
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-mcp-attachment-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

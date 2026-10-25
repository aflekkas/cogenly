import {
  type ModelSelection,
  type ServerProviderModel,
  TextGenerationError,
} from "@cogenly/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@cogenly/shared/git";
import { extractJsonObject } from "@cogenly/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProviderTextGeneration } from "@cogenly/provider-core/server/textGeneration";
import { investigationUnsupported } from "@cogenly/provider-core/server/textGenerationOperations";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@cogenly/provider-core/server/textGenerationPrompts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "@cogenly/provider-core/server/textGenerationUtils";

import type { GrokSettings } from "../settings.ts";
import { createGrokAcpHost, createGrokAcpHostEffect, type GrokAcpHost } from "./acp.ts";
import {
  GROK_MODEL_CONFIG_ID,
  GROK_REASONING_CONFIG_ID,
  parseGrokSessionResult,
  parseGrokSessionUpdate,
  parseGrokStopReason,
} from "./protocol.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

type Operation = keyof ProviderTextGeneration;

/** One ACP turn with no tools: Grok's answer text, or an error. */
async function generateGrokText(
  host: GrokAcpHost,
  cwd: string,
  prompt: string,
  modelId: string | undefined,
) {
  let sessionId: string | undefined;
  let answer = "";
  host.connection.onNotification((notification) => {
    if (notification.method !== "session/update") return;
    const params = notification.params as { sessionId?: unknown; update?: unknown } | undefined;
    if (params?.sessionId !== sessionId) return;
    const update = parseGrokSessionUpdate(params?.update);
    if (update?.type === "agent_message_chunk") answer += update.text;
  });
  // Text generation never approves anything Grok asks for.
  host.connection.onRequest(async (request) => {
    if (request.method === "session/request_permission")
      return { outcome: { outcome: "cancelled" } };
    throw new Error(`Unsupported Grok request during text generation: ${request.method}`);
  });
  const session = parseGrokSessionResult(
    await host.connection.request("session/new", { cwd, mcpServers: [] }),
  );
  sessionId = session.sessionId;
  if (!sessionId) throw new Error("Grok did not return a session.");
  const setConfigOption = (configId: string, value: string) =>
    host.connection.request("session/set_config_option", { sessionId, configId, value });
  // Best effort: a refusal keeps Grok's own model and reasoning tier.
  if (modelId && session.currentModelId !== modelId)
    await setConfigOption(GROK_MODEL_CONFIG_ID, modelId)
      .catch(() => host.connection.request("session/set_model", { sessionId, modelId }))
      .catch(() => undefined);
  // Titles and commit messages need no deep reasoning.
  if (session.reasoningEffort && session.reasoningEffort !== "low")
    await setConfigOption(GROK_REASONING_CONFIG_ID, "low").catch(() => undefined);
  const result = await host.connection.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  const stopReason = parseGrokStopReason(result);
  if (stopReason !== undefined && stopReason !== "end_turn")
    throw new Error(`Grok stopped text generation: ${stopReason}.`);
  return answer;
}

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  settings: GrokSettings,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
    /** Test hook. */
    readonly createHost?: typeof createGrokAcpHost;
  } = {},
) {
  const { environment, modelCatalog = Effect.succeed([]), createHost } = options;
  const fileSystem = yield* FileSystem.FileSystem;
  const runGrokJson = Effect.fn("runGrokJson")(function* <S extends Schema.Top>(input: {
    operation: Operation;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const { operation } = input;
    if (!settings.enabled) {
      return yield* new TextGenerationError({ operation, detail: "Grok is disabled." });
    }
    const selected = input.modelSelection.model.trim();
    const models = yield* modelCatalog;
    const modelId =
      models.find((model) => model.slug === selected)?.slug ??
      (selected || models.find((model) => model.isDefault)?.slug);
    const jsonSchema = yield* encodeJson(toJsonSchemaObject(input.outputSchema)).pipe(
      Effect.mapError(
        (cause) => new TextGenerationError({ operation, detail: "Invalid output schema.", cause }),
      ),
    );
    const response = yield* Effect.gen(function* () {
      // Metadata requests carry their own context and need no checkout.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cogenly-grok-text-" });
      const host = yield* Effect.acquireRelease(
        createGrokAcpHostEffect(
          { binaryPath: settings.binaryPath, cwd, ...(environment ? { environment } : {}) },
          createHost,
        ),
        (host: GrokAcpHost) => Effect.promise(() => host.close()),
        { interruptible: true },
      );
      return yield* Effect.tryPromise(() =>
        generateGrokText(
          host,
          cwd,
          `${input.prompt}\n\nReturn only a JSON object matching this schema, with no markdown fences. Do not use tools or ask questions.\n${jsonSchema}`,
          modelId,
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail:
              "Grok text generation failed. Check the Grok Build login and availability on this Cogenly server host.",
            cause,
          }),
      ),
      Effect.timeoutOption(180_000),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation, detail: "Grok request timed out." })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const decodeOutput = Schema.decodeEffect(input.outputSchema);
    return yield* decodeJson(extractJsonObject(response)).pipe(
      Effect.flatMap(decodeOutput),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Grok returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    "GrokTextGeneration.generateCommitMessage",
  )(function* (input) {
    const generated = yield* runGrokJson({
      operation: "generateCommitMessage",
      ...buildCommitMessagePrompt({ ...input, includeBranch: input.includeBranch === true }),
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });
  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    "GrokTextGeneration.generatePrContent",
  )(function* (input) {
    const generated = yield* runGrokJson({
      operation: "generatePrContent",
      ...buildPrContentPrompt(input),
      modelSelection: input.modelSelection,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });
  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    "GrokTextGeneration.generateBranchName",
  )(function* (input) {
    const generated = yield* runGrokJson({
      operation: "generateBranchName",
      ...buildBranchNamePrompt(input),
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });
  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    "GrokTextGeneration.generateThreadTitle",
  )(function* (input) {
    const generated = yield* runGrokJson({
      operation: "generateThreadTitle",
      ...buildThreadTitlePrompt(input),
      modelSelection: input.modelSelection,
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });
  // Grok runs in an empty temporary directory, so it has no checkout to review.
  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = () =>
    Effect.fail(investigationUnsupported("generateReviewGuide", "Grok"));
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
  } satisfies ProviderTextGeneration;
});

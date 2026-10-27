import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@cogenly/contracts";
import {
  fromRunner,
  decodeJsonReply,
  type Runner,
} from "@cogenly/provider-core/server/textGenerationOperations";
import type { ProviderInstance } from "@cogenly/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

it.effect.each(["claudeAgent", "codex"])(
  "%s uses global and repository instructions for initial, refined and regenerated titles",
  (provider) => {
    const prompts: string[] = [];
    const run: Runner = (request) => {
      prompts.push(request.prompt);
      return decodeJsonReply(request, provider, '{"title":"Durable thread subject"}');
    };
    const operations = fromRunner(provider, run);
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Settings.layerTest({ threadTitleInstructions: "Write in Spanish." }),
      Layer.mock(Registry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed({ textGeneration: operations } as ProviderInstance),
      }),
      Layer.mock(SourceControl.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
      }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const generation = yield* TextGeneration.TextGeneration;
      const input = {
        cwd,
        message: "Fix inbox sorting",
        linkedContext: "Linked issue context",
        modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "test" },
      };
      yield* generation.generateThreadTitle(input);
      expect(prompts.at(-1)).toContain("Write in Spanish.");
      yield* fs.writeFileString(
        `${cwd}/cogenly.json`,
        JSON.stringify({ threadTitleInstructions: "Write in French." }),
      );
      for (const previousTitle of [undefined, "Inbox sorting"]) {
        yield* generation.generateThreadTitle({ ...input, previousTitle });
        const prompt = prompts.at(-1)!;
        expect(prompt).toContain("Write in French.");
        expect(prompt).not.toContain("Write in Spanish.");
        expect(prompt).toContain("Linked issue context");
        expect(prompt).toContain("Do not claim the work is complete.");
        expect(prompt).toContain("3-8 words");
      }
      yield* fs.writeFileString(
        `${cwd}/cogenly.json`,
        JSON.stringify({ threadTitleInstructions: "" }),
      );
      yield* generation.generateThreadTitle(input);
      expect(prompts.at(-1)).not.toContain("Additional instructions:");
      yield* generation.generateThreadTitle({ ...input, instructions: "Use German." });
      expect(prompts.at(-1)).toContain("Use German.");
    }).pipe(
      Effect.provide(TextGeneration.layer.pipe(Layer.provideMerge(dependencies))),
      Effect.scoped,
    );
  },
);

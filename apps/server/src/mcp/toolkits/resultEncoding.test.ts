import { expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { redactValue, redactShortValue } from "../../vault/VaultRedactor.ts";
import { ImageToolkit } from "./images/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { TerminalToolkit } from "./terminal/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { ProjectFilesToolkit } from "./projectFiles/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { IntegrationsToolkit } from "./integrations/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectLabelsToolkit } from "./projectLabels/tools.ts";
import { AccountsToolkit } from "./accounts/tools.ts";
import { MachinesToolkit } from "./machines/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ComputerToolkit } from "./computer/tools.ts";
import { ProjectHomeToolkit } from "./projectHome/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { VaultToolkit } from "./vault/tools.ts";

const tools = [
  ImageToolkit,
  AttachmentToolkit,
  WorktreeToolkit,
  TerminalToolkit,
  HtmlToolkit,
  ProjectFilesToolkit,
  ProjectToolkit,
  IntegrationsToolkit,
  PreviewControlsToolkit,
  ProjectLabelsToolkit,
  AccountsToolkit,
  MachinesToolkit,
  EnvironmentToolkit,
  PreviewToolkit,
  DeviceToolkit,
  PullRequestsToolkit,
  ComputerToolkit,
  ProjectHomeToolkit,
  ThreadToolkit,
  OrchestratorToolkit,
  VaultToolkit,
].flatMap((toolkit) => Object.values(toolkit.tools));

// Exercise the same typed-value -> scrub -> JSON codec boundary as MCP. A
// nonmatching secret still triggers traversal of every object in each result.
it.effect.each(tools.map((tool) => [tool.name, tool] as const))(
  "%s: its result still encodes after vault scrubbing",
  ([, tool]) =>
    Effect.gen(function* () {
      const schema = tool.successSchema as Schema.Codec<unknown, unknown>;
      const values = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        count: 3,
        size: 3,
        seed: 33,
      });
      const encode = Schema.encodeEffect(Schema.toCodecJson(schema));
      for (const value of values) {
        const scrubbed = redactShortValue(redactValue(value, ["__encoding_test_secret__"]), [
          "__short__",
        ]);
        expect(yield* encode(scrubbed)).toEqual(yield* encode(value));
      }
    }),
);

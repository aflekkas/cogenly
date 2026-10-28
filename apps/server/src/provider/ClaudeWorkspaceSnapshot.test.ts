import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { probeClaudeWorkspaceSnapshot } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

it.effect("finishes a deleted worktree scan instead of leaving its commands pending", () =>
  Effect.gen(function* () {
    const machine: ServerProvider = {
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claude"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      decodeClaudeSettings({}),
      machine,
      "/nonexistent/cogenly-deleted-worktree",
      { HOME: "/nonexistent/cogenly-provider-home" },
    );
    expect(snapshot.slashCommandsPending).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

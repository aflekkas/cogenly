import {
  AuthSettingsWriteScope,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { resolveCliServerRoute, SETUP_CLI_SCOPES } from "./liveServer.ts";

describe("resolveCliServerRoute", () => {
  const route = (input: { recorded: boolean; reachable: boolean; owned: boolean }) => {
    const calls: Array<string> = [];
    return resolveCliServerRoute({
      recordedOrigin: input.recorded ? Option.some("http://127.0.0.1:4773") : Option.none(),
      reachable: (origin) =>
        Effect.sync(() => {
          calls.push(`probe ${origin}`);
          return input.reachable;
        }),
      acquireOwnership: Effect.suspend(() => {
        calls.push("own");
        return input.owned ? Effect.fail("ServerAlreadyRunning" as const) : Effect.void;
      }),
    }).pipe(
      Effect.exit,
      Effect.map((exit) => ({ exit, calls })),
    );
  };

  it.effect("uses a recorded server that answers, without taking the home", () =>
    Effect.gen(function* () {
      const { exit, calls } = yield* route({ recorded: true, reachable: true, owned: true });
      expect(exit).toEqual(Exit.succeed({ _tag: "live", origin: "http://127.0.0.1:4773" }));
      expect(calls).toEqual(["probe http://127.0.0.1:4773"]);
    }),
  );

  it.effect("works on the home directly when no server is recorded", () =>
    Effect.gen(function* () {
      const { exit, calls } = yield* route({ recorded: false, reachable: false, owned: false });
      expect(exit).toEqual(Exit.succeed({ _tag: "offline" }));
      expect(calls).toEqual(["own"]);
    }),
  );

  it.effect("falls back to the home when the recorded server is gone", () =>
    Effect.gen(function* () {
      const { exit } = yield* route({ recorded: true, reachable: false, owned: false });
      expect(exit).toEqual(Exit.succeed({ _tag: "offline" }));
    }),
  );

  it.effect("refuses a home a silent server still owns instead of writing behind it", () =>
    Effect.gen(function* () {
      const { exit, calls } = yield* route({ recorded: true, reachable: false, owned: true });
      expect(exit).toEqual(Exit.fail("ServerAlreadyRunning"));
      expect(calls).toEqual(["probe http://127.0.0.1:4773", "own"]);
    }),
  );
});

describe("the setup CLI's RPC grants", () => {
  const called = [
    WS_METHODS.serverGetConfig,
    WS_METHODS.serverRefreshProviders,
    WS_METHODS.serverGetSettings,
    WS_METHODS.serverUpdateSettings,
    WS_METHODS.t3ImportStatus,
    WS_METHODS.t3ImportScan,
    WS_METHODS.t3ImportRun,
    WS_METHODS.t3ImportCancel,
    WS_METHODS.agentSessionsScan,
    WS_METHODS.agentSessionsImport,
    WS_METHODS.projectsMutate,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<
        keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
        (typeof called)[number]
      > => !(called as ReadonlyArray<string>).includes(tag),
    ),
  );
  // Reaching a handler means authorization passed; each one stops right there.
  const handled = () => Effect.die("handled");
  const handlers = Layer.mergeAll(
    group.toLayerHandler(WS_METHODS.serverGetConfig, handled),
    group.toLayerHandler(WS_METHODS.serverRefreshProviders, handled),
    group.toLayerHandler(WS_METHODS.serverGetSettings, handled),
    group.toLayerHandler(WS_METHODS.serverUpdateSettings, handled),
    group.toLayerHandler(WS_METHODS.t3ImportStatus, () => Stream.die("handled")),
    group.toLayerHandler(WS_METHODS.t3ImportScan, handled),
    group.toLayerHandler(WS_METHODS.t3ImportRun, handled),
    group.toLayerHandler(WS_METHODS.t3ImportCancel, handled),
    group.toLayerHandler(WS_METHODS.agentSessionsScan, handled),
    group.toLayerHandler(WS_METHODS.agentSessionsImport, handled),
    group.toLayerHandler(WS_METHODS.projectsMutate, handled),
  );
  const reachedHandler = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.exit,
      Effect.map((exit) => Exit.isFailure(exit) && Cause.squash(exit.cause) === "handled"),
    );
  const makeClient = RpcTest.makeClient(group);
  const calls = (client: Effect.Success<typeof makeClient>) => {
    const instanceId = ProviderInstanceId.make("claude-personal");
    return {
      config: reachedHandler(client[WS_METHODS.serverGetConfig]({})),
      providers: reachedHandler(client[WS_METHODS.serverRefreshProviders]({})),
      settings: reachedHandler(client[WS_METHODS.serverGetSettings]({})),
      addInstance: reachedHandler(
        client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation: {
            operation: "create",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: "~/.claude_personal" },
            },
          },
        }),
      ),
      defaultModel: reachedHandler(
        client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultModelSelection: { instanceId, model: "claude-opus-4-1" } },
        }),
      ),
      importStatus: reachedHandler(Stream.runDrain(client[WS_METHODS.t3ImportStatus]({}))),
      importScan: reachedHandler(
        client[WS_METHODS.t3ImportScan]({ scope: { sourceProjectIds: [] } }),
      ),
      importRun: reachedHandler(
        client[WS_METHODS.t3ImportRun]({ reportId: "r", includeSettings: true }),
      ),
      importCancel: reachedHandler(client[WS_METHODS.t3ImportCancel]({})),
      sessionsScan: reachedHandler(client[WS_METHODS.agentSessionsScan]({})),
      sessionsImport: reachedHandler(
        client[WS_METHODS.agentSessionsImport]({
          projectId: ProjectId.make("p"),
          expectedWorkspaceRoot: "/code/p",
        }),
      ),
      projectCreate: reachedHandler(
        client[WS_METHODS.projectsMutate]({
          type: "project.create",
          commandId: CommandId.make("c"),
          projectId: ProjectId.make("p"),
          title: "p",
          workspaceRoot: "/code/p",
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        }),
      ),
    };
  };

  it.effect("cover every call setup and t3-import make", () =>
    Effect.gen(function* () {
      const client = yield* makeClient.pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([...SETUP_CLI_SCOPES]))),
      );
      const all = calls(client);
      const results = yield* Effect.all(all);
      expect(results).toEqual(Object.fromEntries(Object.keys(all).map((name) => [name, true])));
    }).pipe(Effect.scoped),
  );

  it.effect("hold the CLI to the same Settings grant as Settings → Import", () =>
    Effect.gen(function* () {
      const client = yield* makeClient.pipe(
        Effect.provide(
          Layer.merge(
            handlers,
            RpcAuthorization.layer(
              SETUP_CLI_SCOPES.filter((scope) => scope !== AuthSettingsWriteScope),
            ),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.t3ImportScan]({ scope: { sourceProjectIds: [] } }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthSettingsWriteScope,
      });
    }).pipe(Effect.scoped),
  );
});

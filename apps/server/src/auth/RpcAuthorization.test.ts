import {
  AccountId,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthPeerScopes,
  AuthStandardClientScopes,
  clientRpcRequiredScopes,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it.each([
    WS_METHODS.projectLabelsMerge,
    WS_METHODS.projectLabelsDismissDuplicate,
    WS_METHODS.projectLabelsUndismissDuplicate,
  ])("requires the operate grant for %s on server and client", (method) => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
  });
  it("requires orchestration read access for generated chat greetings", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetChatGreeting)).toBe(
      AuthOrchestrationReadScope,
    );
  });
  it("requires orchestration read access for global search", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.searchQuery)).toBe(AuthOrchestrationReadScope);
  });
  it.each([WS_METHODS.exportCreate, WS_METHODS.exportValidate, WS_METHODS.exportList])(
    "requires the owner Settings grant for %s",
    (method) => {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    },
  );
  it.each([
    WS_METHODS.t3ImportStatus,
    WS_METHODS.t3ImportScan,
    WS_METHODS.t3ImportRun,
    WS_METHODS.t3ImportCancel,
  ])("requires the Settings grant for %s, on the client too", (method) => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthSettingsWriteScope]);
  });
  it("protects permanent commitment deletion", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.commitmentsDelete)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("requires operate access to start Work", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workStart)).toBe(AuthOrchestrationOperateScope);
  });

  it("requires operate access to create a project's chat", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.projectLabelsMergeFileStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectLabelsEnsureProjectChat)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires owner operate authority for agent decisions and commitment mutations", () => {
    for (const method of [
      WS_METHODS.agentsRequestApproval,
      WS_METHODS.agentsApprove,
      WS_METHODS.agentsReject,
      WS_METHODS.agentsStartWork,
      WS_METHODS.factsCreate,
      WS_METHODS.factsUpdate,
      WS_METHODS.factsSupersede,
      WS_METHODS.factsRetract,
      WS_METHODS.contextSetEnabled,
      WS_METHODS.commitmentsCreate,
      WS_METHODS.commitmentsUpdateStatus,
      WS_METHODS.commitmentsConfirm,
      WS_METHODS.commitmentsDismiss,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    for (const method of [
      WS_METHODS.agentsApprovalsList,
      WS_METHODS.threadApprovalsSubscribe,
      WS_METHODS.agentsActivity,
      WS_METHODS.factsList,
      WS_METHODS.factsHistory,
      WS_METHODS.contextForRun,
      WS_METHODS.contextSettings,
      WS_METHODS.commitmentsList,
      WS_METHODS.commitmentsHistory,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  });

  it("separates vault metadata reads from vault writes, on the client too", () => {
    for (const method of [WS_METHODS.vaultList, WS_METHODS.vaultUsage]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationReadScope]);
    }
    for (const method of [WS_METHODS.vaultCreate, WS_METHODS.vaultUpdate, WS_METHODS.vaultDelete]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
    }
    // Sharing makes another machine a holder of every shared secret: access
    // management, which standard clients and agents do not have.
    expect(requiredScopeForRpcMethod(WS_METHODS.vaultSetPeerSharing)).toBe(AuthAccessWriteScope);
    expect(clientRpcRequiredScopes(WS_METHODS.vaultSetPeerSharing, {})).toEqual([
      AuthAccessWriteScope,
    ]);
    expect(requiredScopeForRpcMethod(WS_METHODS.vaultSharingStatus)).toBe(AuthAccessReadScope);
    expect(clientRpcRequiredScopes(WS_METHODS.vaultSharingStatus, {})).toEqual([
      AuthAccessReadScope,
    ]);
    expect(AuthStandardClientScopes).not.toContain(AuthAccessWriteScope);
  });

  it("guards integration secret forms, the runtime installer and the sources feed, on the client too", () => {
    for (const method of [
      WS_METHODS.integrationsSaveOAuthClient,
      WS_METHODS.integrationsSaveApiKey,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.integrationsInstallRuntime)).toBe(
      AuthProvidersManageScope,
    );
    expect(clientRpcRequiredScopes(WS_METHODS.integrationsInstallRuntime, {})).toEqual([
      AuthProvidersManageScope,
    ]);
    expect(requiredScopeForRpcMethod(WS_METHODS.integrationsSubscribeSources)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(AuthStandardClientScopes).toContain(AuthOrchestrationReadScope);
  });

  it("keeps machine pairing behind access management, which standard clients lack", () => {
    for (const method of [
      WS_METHODS.machinesPrepareJoin,
      WS_METHODS.machinesCreatePeerGrant,
      WS_METHODS.machinesJoinHub,
      WS_METHODS.machinesUnpair,
      // Setup installs software and exposes the server; its status carries sign-in links.
      WS_METHODS.machinesSetupStatus,
      WS_METHODS.machinesSetupSubscribe,
      WS_METHODS.machinesSetupRunStep,
      WS_METHODS.machinesSetupDisableServe,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessWriteScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthAccessWriteScope]);
    }
    expect(AuthStandardClientScopes).not.toContain(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.machinesUpdate)).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.machinesList)).toBe(AuthOrchestrationReadScope);
  });

  it("never lets a peer scope authorize a client RPC", () => {
    for (const scope of Object.values(RPC_REQUIRED_SCOPES)) {
      expect(AuthPeerScopes).not.toContain(scope);
    }
  });

  it("requires operate access to stop a workflow", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_V2_WS_METHODS.stopWorkflow)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("requires source control writes to start, retry, or cancel project clones", () => {
    for (const method of [
      WS_METHODS.projectCloneStart,
      WS_METHODS.projectCloneRetry,
      WS_METHODS.projectCloneCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeProjectClones)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("requires operate access to move threads or a project to another machine, on the client too", () => {
    for (const method of [
      WS_METHODS.machinesMoveThreads,
      WS_METHODS.machinesMoveAllThreads,
      WS_METHODS.projectLabelsMoveToMachine,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
    }
  });

  it.each([WS_METHODS.projectLabelsAdoptOrphanFolder, WS_METHODS.projectLabelsTrashOrphanFolder])(
    "requires operate access for %s, on the client too, while listing orphans is a read",
    (method) => {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
      expect(requiredScopeForRpcMethod(WS_METHODS.projectLabelsListOrphanFolders)).toBe(
        AuthOrchestrationReadScope,
      );
    },
  );

  it.each([
    WS_METHODS.projectLabelsCheckoutRepository,
    WS_METHODS.projectLabelsRemoveCheckout,
    WS_METHODS.projectLabelsAdoptRepository,
  ])("requires source control writes for %s, on the client too", (method) => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthSourceControlWriteScope]);
  });

  it("separates viewing pull request file progress from writing it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsFilesViewed)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSetFilesViewed)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAdjust,
      WS_METHODS.previewClearProfile,
      WS_METHODS.previewReportProfiles,
      WS_METHODS.previewReportShown,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalKill,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("project folders do not let read-only clients move threads or change membership", () =>
  Effect.gen(function* () {
    const tested = [
      WS_METHODS.projectLabelsList,
      WS_METHODS.projectLabelsMoveThread,
      WS_METHODS.projectLabelsSetThreadLabels,
    ] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    let writes = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectLabelsList, () => Effect.succeed({ labels: [] })),
          group.toLayerHandler(WS_METHODS.projectLabelsMoveThread, (input) =>
            Effect.sync(() => {
              writes++;
              return { threadId: input.threadId, projectFolderId: input.folderId };
            }),
          ),
          group.toLayerHandler(WS_METHODS.projectLabelsSetThreadLabels, () =>
            Effect.sync(() => {
              writes++;
              return { labels: [] };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.projectLabelsList]({})).toEqual({ labels: [] });
    expect(
      yield* client[WS_METHODS.projectLabelsMoveThread]({
        threadId: ThreadId.make("filed"),
        folderId: null,
      }).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(
      yield* client[WS_METHODS.projectLabelsSetThreadLabels]({
        threadId: ThreadId.make("tagged"),
        labelIds: [],
      }).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(writes).toBe(0);
    expect(requiredScopeForRpcMethod(ORCHESTRATION_V2_WS_METHODS.getThreadProjection)).toBe(
      AuthOrchestrationReadScope,
    );
  }).pipe(Effect.scoped),
);

it.effect("lets a read-only client see a thread's pending approvals but not decide them", () =>
  Effect.gen(function* () {
    const tested = [WS_METHODS.threadApprovalsSubscribe, WS_METHODS.agentsApprove] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    let decisions = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.threadApprovalsSubscribe, () =>
            Stream.make({ approvals: [] }),
          ),
          group.toLayerHandler(WS_METHODS.agentsApprove, () =>
            Effect.sync(() => {
              decisions += 1;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.threadApprovalsSubscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      ),
    ).toEqual([{ approvals: [] }]);
    expect(
      yield* client[WS_METHODS.agentsApprove]({ id: "approval:vault:test" }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(decisions).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect(
  "allows account metadata reads but blocks account disconnection before the handler without operate permission",
  () =>
    Effect.gen(function* () {
      const tested = [WS_METHODS.accountsList, WS_METHODS.accountsDisconnect] as const;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
            !(tested as ReadonlyArray<string>).includes(tag),
        ),
      );
      let mutations = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.accountsList, () =>
              Effect.succeed({ accounts: [], statuses: [], services: [] }),
            ),
            group.toLayerHandler(WS_METHODS.accountsDisconnect, () =>
              Effect.sync(() => {
                mutations += 1;
                return { disconnected: true };
              }),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect((yield* client[WS_METHODS.accountsList]({ scopeProjectId: null })).accounts).toEqual(
        [],
      );
      expect(
        yield* client[WS_METHODS.accountsDisconnect]({
          id: AccountId.make("account:test"),
          scopeProjectId: null,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
      expect(mutations).toBe(0);
    }).pipe(Effect.scoped),
);

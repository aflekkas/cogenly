import * as Search from "./search.ts";
import * as Facts from "./fact.ts";
import * as Visual from "./visual.ts";
import * as Exports from "./export.ts";
import * as T3Import from "./t3Import.ts";
import * as ProjectLabels from "./projectLabel.ts";
import * as Integrations from "./integration.ts";
import * as Machines from "./machine.ts";
import * as Work from "./work.ts";
import * as Vault from "./vault.ts";
import * as Accounts from "./accounts.ts";
import * as AgentWorkspace from "./agentWorkspace.ts";
import * as AgentBuilder from "./agentBuilder.ts";
import * as Agents from "./agent.ts";
import {
  OrchestrationV2SearchThreadError,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "./orchestrationV2.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  McpAppCallToolInput,
  McpAppCallToolResult,
  McpAppReadResourceInput,
  McpAppReadResourceResult,
  McpAppRequestError,
  McpAppToolInfo,
  McpAppToolInfoInput,
  McpAppUpdateModelContextInput,
} from "./mcpApps.ts";
import {
  ChatGptReconnectProfileInput,
  ChatGptReconnectProfile,
  ChatGptImportProfileInput,
  ChatGptHandoffInput,
  ChatGptHandoffState,
} from "./providerSetup.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CodexAuthCallbackInput,
  CodexAuthCallbackState,
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";
import { ExternalLauncherError, RevealInFileManagerInput } from "./externalLauncher.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  PersistChatAttachmentsError,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
} from "./chatAttachment.ts";
import {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
} from "./checkpointDiff.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusSubscriptionInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId, ProviderInstanceMutation } from "./providerInstance.ts";
import { PullRequestReviewGuideResult } from "./pullRequestReviewGuide.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestPreview,
  PullRequestChecks,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestFilesViewedResult,
  PullRequestInvalidateInput,
  PullRequestReportStateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSetFilesViewedInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
} from "./orchestrationV2.ts";
import {
  ProjectCreateNewInput,
  ProjectCreateNewResult,
  ProjectEnsureScratchResult,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalObserveInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalKillInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewClearProfileError,
  PreviewClearProfileInput,
  PreviewReportProfilesInput,
  PreviewReportShownInput,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewAdjustInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import {
  StorageCleanupReport,
  DatabaseStorageStatus,
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskListInput,
  ScheduledTaskListResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
} from "./scheduledTask.ts";
import { SecretRequestAnswerInput, SecretRequestError } from "./secretRequest.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import { Project, ProjectMutation, ProjectMutationError } from "./project.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsMutate: "projects.mutate",
  projectsEnsureScratch: "projects.ensureScratch",
  projectsCreateNew: "projects.createNew",

  // Shell methods
  shellRevealInFileManager: "shell.revealInFileManager",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  filesystemGetMetadata: "filesystem.getMetadata",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  t3ImportStatus: "t3Import.status",
  t3ImportScan: "t3Import.scan",
  t3ImportRun: "t3Import.run",
  t3ImportCancel: "t3Import.cancel",
  assetsCreateUrl: "assets.createUrl",
  assetsPersistChatAttachments: "assets.persistChatAttachments",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  // MCP Apps methods
  mcpAppsCallTool: "mcpApps.callTool",
  mcpAppsToolInfo: "mcpApps.toolInfo",
  mcpAppsReadResource: "mcpApps.readResource",
  mcpAppsUpdateModelContext: "mcpApps.updateModelContext",

  // Interactive HTML render state methods
  visualStateGet: "visual.state.get",
  visualStateSet: "visual.state.set",
  visualStateSubmit: "visual.state.submit",

  // Provider methods
  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  chatGptReconnectProfile: "provider.chatgpt.reconnect-profile",
  chatGptImportProfile: "provider.chatgpt.import-profile",
  chatGptHandoffSubscribe: "provider.chatgpt.handoff.subscribe",
  codexAuthCallbackSubscribe: "provider.codex.auth-callback.subscribe",
  providerAuthRespond: "provider.auth.respond",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalObserve: "terminal.observe",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalKill: "terminal.kill",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewAdjust: "preview.adjust",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewClearProfile: "preview.clearProfile",
  previewReportProfiles: "preview.reportProfiles",
  previewReportShown: "preview.reportShown",
  previewReportStatus: "preview.reportStatus",

  // Device methods
  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverRunStorageCleanup: "server.runStorageCleanup",
  serverGetStorageCleanupReport: "server.getStorageCleanupReport",
  serverGetDatabaseStorage: "server.getDatabaseStorage",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverCheckOtlpEndpoint: "server.checkOtlpEndpoint",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  // Persistent agents and their scheduled-task triggers
  searchQuery: "search.query",
  exportCreate: "export.create",
  exportValidate: "export.validate",
  exportList: "export.list",
  commitmentsDelete: "commitments.delete",
  projectLabelsList: "projectLabels.list",
  projectLabelsSubscribe: "projectLabels.subscribe",
  projectLabelsCreate: "projectLabels.create",
  projectLabelsUpdate: "projectLabels.update",
  projectLabelsDelete: "projectLabels.delete",
  projectLabelsArchive: "projectLabels.archive",
  projectLabelsUnarchive: "projectLabels.unarchive",
  projectLabelsLinkRepository: "projectLabels.linkRepository",
  projectLabelsUnlinkRepository: "projectLabels.unlinkRepository",
  projectLabelsGetThreadLabels: "projectLabels.getThreadLabels",
  projectLabelsSubscribeThreadLabels: "projectLabels.subscribeThreadLabels",
  projectLabelsSubscribeConfirmedThreadLabels: "projectLabels.subscribeConfirmedThreadLabels",
  projectLabelsMoveThread: "projectLabels.moveThread",
  projectLabelsForkThreadToProject: "projectLabels.forkThreadToProject",
  projectLabelsSetThreadLabels: "projectLabels.setThreadLabels",
  projectLabelsLinkSource: "projectLabels.linkSource",
  projectLabelsUnlinkSource: "projectLabels.unlinkSource",
  projectLabelsSearchOwnerRepositories: "projectLabels.searchOwnerRepositories",
  projectLabelsCloneRepository: "projectLabels.cloneRepository",
  projectLabelsListResources: "projectLabels.listResources",
  projectLabelsSubscribeResources: "projectLabels.subscribeResources",
  projectLabelsAddResource: "projectLabels.addResource",
  projectLabelsRemoveResource: "projectLabels.removeResource",
  projectLabelsReadResource: "projectLabels.readResource",
  projectLabelsEnsureProjectChat: "projectLabels.ensureProjectChat",
  workStart: "work.start",
  agentsList: "agents.list",
  agentsSubscribe: "agents.subscribe",
  agentsUpsert: "agents.upsert",
  agentsDelete: "agents.delete",
  agentsSend: "agents.send",
  agentsMarkRead: "agents.markRead",
  agentsSetProject: "agents.setProject",
  agentsMemoryList: "agents.memoryList",
  agentsMemoryWrite: "agents.memoryWrite",
  agentsMemoryForget: "agents.memoryForget",
  agentsRuns: "agents.runs",
  agentsBuilderStart: "agents.builderStart",
  agentsApprovalsList: "agents.approvalsList",
  agentsRequestApproval: "agents.requestApproval",
  agentsApprove: "agents.approve",
  agentsReject: "agents.reject",
  agentsStartWork: "agents.startWork",
  agentsActivity: "agents.activity",
  factsList: "facts.list",
  factsCreate: "facts.create",
  factsUpdate: "facts.update",
  factsSupersede: "facts.supersede",
  factsRetract: "facts.retract",
  factsHistory: "facts.history",
  contextForRun: "context.forRun",
  contextSettings: "context.settings",
  contextSetEnabled: "context.setEnabled",
  commitmentsList: "commitments.list",
  commitmentsCreate: "commitments.create",
  commitmentsUpdateStatus: "commitments.updateStatus",
  commitmentsConfirm: "commitments.confirm",
  commitmentsDismiss: "commitments.dismiss",
  commitmentsHistory: "commitments.history",

  scheduledTasksList: "scheduledTasks.list",
  scheduledTasksSubscribe: "scheduledTasks.subscribe",
  scheduledTasksUpsert: "scheduledTasks.upsert",
  scheduledTasksSetEnabled: "scheduledTasks.setEnabled",
  scheduledTasksDelete: "scheduledTasks.delete",
  scheduledTasksRunNow: "scheduledTasks.runNow",
  scheduledTasksRotateWebhookToken: "scheduledTasks.rotateWebhookToken",
  secretsAnswerRequest: "secrets.answerRequest",
  accountsConnect: "accounts.connect",
  accountsUse: "accounts.use",
  accountsRemoveAccess: "accounts.removeAccess",
  accountsList: "accounts.list",
  accountsGet: "accounts.get",
  accountsCreate: "accounts.create",
  accountsUpdate: "accounts.update",
  accountsDisconnect: "accounts.disconnect",
  vaultList: "vault.list",
  vaultCreate: "vault.create",
  vaultUpdate: "vault.update",
  vaultDelete: "vault.delete",
  vaultUsage: "vault.usage",
  scheduledTasksListWebhookDeliveries: "scheduledTasks.listWebhookDeliveries",
  scheduledTasksGetWebhookDelivery: "scheduledTasks.getWebhookDelivery",

  // Cogenly-managed integrations (upstream MCP servers behind the gateway)
  integrationsList: "integrations.list",
  integrationsCreate: "integrations.create",
  integrationsUpdate: "integrations.update",
  integrationsDelete: "integrations.delete",
  integrationsTestConnection: "integrations.testConnection",

  // Machines: this server, its hub, and its paired spokes
  machinesList: "machines.list",
  machinesSubscribe: "machines.subscribe",
  machinesUpdate: "machines.update",
  machinesPrepareJoin: "machines.prepareJoin",
  machinesCreatePeerGrant: "machines.createPeerGrant",
  machinesJoinHub: "machines.joinHub",
  machinesUnpair: "machines.unpair",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsPreview: "pullRequests.preview",
  pullRequestsChecks: "pullRequests.checks",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsReviewGuide: "pullRequests.reviewGuide",
  pullRequestsGenerateReviewGuide: "pullRequests.generateReviewGuide",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsFilesViewed: "pullRequests.filesViewed",
  pullRequestsSetFilesViewed: "pullRequests.setFilesViewed",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReportState: "pullRequests.reportState",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    /** With `instanceId` and `cwd`: rescan the workspace's skills and slash
     * commands even when a snapshot for that cwd already exists. */
    fresh: Schema.optional(Schema.Boolean),
    /** Explicit user request: bypass T3-owned caches and rediscover models.
     * Background status refreshes must not open agent sessions. */
    refreshModels: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthRespondRpc = Rpc.make(WS_METHODS.providerAuthRespond, {
  payload: ProviderAuthRespondInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsChatGptReconnectProfileRpc = Rpc.make(WS_METHODS.chatGptReconnectProfile, {
  payload: ChatGptReconnectProfileInput,
  success: Schema.NullOr(ChatGptReconnectProfile),
  error: ProviderSetupRpcError,
});
const WsChatGptImportProfileRpc = Rpc.make(WS_METHODS.chatGptImportProfile, {
  payload: ChatGptImportProfileInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});
const WsChatGptHandoffSubscribeRpc = Rpc.make(WS_METHODS.chatGptHandoffSubscribe, {
  payload: ChatGptHandoffInput,
  success: ChatGptHandoffState,
  error: ProviderSetupRpcError,
  stream: true,
});
const WsCodexAuthCallbackSubscribeRpc = Rpc.make(WS_METHODS.codexAuthCallbackSubscribe, {
  payload: CodexAuthCallbackInput,
  success: CodexAuthCallbackState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerRunStorageCleanupRpc = Rpc.make(WS_METHODS.serverRunStorageCleanup, {
  payload: Schema.Struct({}),
  success: StorageCleanupReport,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});
const WsServerGetStorageCleanupReportRpc = Rpc.make(WS_METHODS.serverGetStorageCleanupReport, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(StorageCleanupReport),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsServerGetDatabaseStorageRpc = Rpc.make(WS_METHODS.serverGetDatabaseStorage, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(DatabaseStorageStatus),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerCheckOtlpEndpointRpc = Rpc.make(WS_METHODS.serverCheckOtlpEndpoint, {
  payload: OtlpEndpointCheckInput,
  success: OtlpEndpointCheckResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

/**
 * Refetches the model rate table ahead of its daily TTL, so a model released
 * since the last fetch gets priced. The next usage summary uses the new table.
 */
const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsPreviewRpc = Rpc.make(WS_METHODS.pullRequestsPreview, {
  payload: PullRequestRef,
  success: PullRequestPreview,
  error: PullRequestRpcError,
});

const WsPullRequestsChecksRpc = Rpc.make(WS_METHODS.pullRequestsChecks, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestChecks),
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsGenerateReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsGenerateReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsFilesViewed, {
  payload: PullRequestRef,
  success: PullRequestFilesViewedResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSetFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsSetFilesViewed, {
  payload: PullRequestSetFilesViewedInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReportStateRpc = Rpc.make(WS_METHODS.pullRequestsReportState, {
  payload: PullRequestReportStateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/** Read when the label menu opens, for the same reason the reviewer candidates are. */
const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsProjectsMutateRpc = Rpc.make(WS_METHODS.projectsMutate, {
  payload: ProjectMutation,
  success: Project,
  error: Schema.Union([ProjectMutationError, EnvironmentAuthorizationError]),
});

// Finds or creates the Scratch project rooted at ServerConfig.scratchWorkspaceRoot.
const WsProjectsEnsureScratchRpc = Rpc.make(WS_METHODS.projectsEnsureScratch, {
  payload: Schema.Struct({}),
  success: ProjectEnsureScratchResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

// Makes a folder under ServerConfig.newProjectsRoot with a first commit, then the project.
const WsProjectsCreateNewRpc = Rpc.make(WS_METHODS.projectsCreateNew, {
  payload: ProjectCreateNewInput,
  success: ProjectCreateNewResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsShellRevealInFileManagerRpc = Rpc.make(WS_METHODS.shellRevealInFileManager, {
  payload: RevealInFileManagerInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemGetMetadataRpc = Rpc.make(WS_METHODS.filesystemGetMetadata, {
  payload: FilesystemGetMetadataInput,
  success: FilesystemGetMetadataResult,
  error: EnvironmentAuthorizationError,
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

const WsT3ImportStatusRpc = Rpc.make(WS_METHODS.t3ImportStatus, {
  payload: Schema.Struct({}),
  success: T3Import.T3ImportStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsT3ImportScanRpc = Rpc.make(WS_METHODS.t3ImportScan, {
  payload: T3Import.T3ImportScanInput,
  success: T3Import.T3ImportStarted,
  error: Schema.Union([T3Import.T3ImportError, EnvironmentAuthorizationError]),
});

const WsT3ImportRunRpc = Rpc.make(WS_METHODS.t3ImportRun, {
  payload: T3Import.T3ImportRunInput,
  success: T3Import.T3ImportStarted,
  error: Schema.Union([T3Import.T3ImportError, EnvironmentAuthorizationError]),
});

const WsT3ImportCancelRpc = Rpc.make(WS_METHODS.t3ImportCancel, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ cancelled: Schema.Boolean }),
  error: EnvironmentAuthorizationError,
});

const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAssetsPersistChatAttachmentsRpc = Rpc.make(WS_METHODS.assetsPersistChatAttachments, {
  payload: PersistChatAttachmentsInput,
  success: PersistChatAttachmentsResult,
  error: Schema.Union([PersistChatAttachmentsError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsMcpAppsCallToolRpc = Rpc.make(WS_METHODS.mcpAppsCallTool, {
  payload: McpAppCallToolInput,
  success: McpAppCallToolResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsToolInfoRpc = Rpc.make(WS_METHODS.mcpAppsToolInfo, {
  payload: McpAppToolInfoInput,
  success: McpAppToolInfo,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsUpdateModelContextRpc = Rpc.make(WS_METHODS.mcpAppsUpdateModelContext, {
  payload: McpAppUpdateModelContextInput,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsReadResourceRpc = Rpc.make(WS_METHODS.mcpAppsReadResource, {
  payload: McpAppReadResourceInput,
  success: McpAppReadResourceResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsVisualStateGetRpc = Rpc.make(WS_METHODS.visualStateGet, {
  payload: Visual.VisualStateGetInput,
  success: Visual.VisualStateGetResult,
  error: Schema.Union([Visual.VisualStateError, EnvironmentAuthorizationError]),
});

const WsVisualStateSetRpc = Rpc.make(WS_METHODS.visualStateSet, {
  payload: Visual.VisualStateSetInput,
  success: Visual.VisualState,
  error: Schema.Union([Visual.VisualStateError, EnvironmentAuthorizationError]),
});

const WsVisualStateSubmitRpc = Rpc.make(WS_METHODS.visualStateSubmit, {
  payload: Visual.VisualStateSubmitInput,
  success: Visual.VisualStateSubmitResult,
  error: Schema.Union([Visual.VisualStateError, EnvironmentAuthorizationError]),
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusSubscriptionInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalObserveRpc = Rpc.make(WS_METHODS.terminalObserve, {
  payload: TerminalObserveInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalKillRpc = Rpc.make(WS_METHODS.terminalKill, {
  payload: TerminalKillInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAdjustRpc = Rpc.make(WS_METHODS.previewAdjust, {
  payload: PreviewAdjustInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewClearProfileRpc = Rpc.make(WS_METHODS.previewClearProfile, {
  payload: PreviewClearProfileInput,
  error: Schema.Union([PreviewClearProfileError, EnvironmentAuthorizationError]),
});

const WsPreviewReportProfilesRpc = Rpc.make(WS_METHODS.previewReportProfiles, {
  payload: PreviewReportProfilesInput,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportShownRpc = Rpc.make(WS_METHODS.previewReportShown, {
  payload: PreviewReportShownInput,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationV2DispatchCommandRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
  payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
  success: OrchestrationV2RpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetTurnDiffRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
  payload: OrchestrationV2RpcSchemas.getTurnDiff.input,
  success: OrchestrationV2RpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationV2RpcSchemas.getFullThreadDiff.input,
    success: OrchestrationV2RpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2SearchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThread, {
  payload: OrchestrationV2SearchThreadInput,
  success: OrchestrationV2SearchThreadResult,
  error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SearchThreadStreamRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  {
    payload: OrchestrationV2SearchThreadInput,
    success: OrchestrationV2SearchThreadResult,
    error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SearchThreadsRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationSearchThreadsResult,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadProjectionRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2StopWorkflowRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.stopWorkflow, {
  payload: OrchestrationV2RpcSchemas.stopWorkflow.input,
  success: OrchestrationV2RpcSchemas.stopWorkflow.output,
  error: Schema.Union([OrchestrationV2StopWorkflowError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationV2RpcSchemas.getWorkflowScript.input,
    success: OrchestrationV2RpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2RpcSchemas.getTurnItem.input,
  success: OrchestrationV2RpcSchemas.getTurnItem.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2LaunchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
  payload: OrchestrationV2RpcSchemas.launchThread.input,
  success: OrchestrationV2RpcSchemas.launchThread.output,
  error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SubscribeArchivedShellRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
  {
    payload: OrchestrationV2RpcSchemas.subscribeArchivedShell.input,
    success: OrchestrationV2RpcSchemas.subscribeArchivedShell.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SubscribeShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2RpcSchemas.subscribeShell.input,
  success: OrchestrationV2RpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
  payload: OrchestrationV2RpcSchemas.subscribeThread.input,
  success: OrchestrationV2RpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeCommandOutputRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  {
    payload: OrchestrationV2RpcSchemas.subscribeCommandOutput.input,
    success: OrchestrationV2RpcSchemas.subscribeCommandOutput.output,
    error: Schema.Union([OrchestrationV2CommandOutputError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /** Whether this client understands `usageLimitSourcesUpdated` events. */
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSearchQueryRpc = Rpc.make(WS_METHODS.searchQuery, {
  payload: Search.SearchQueryInput,
  success: Search.SearchQueryResult,
  error: Schema.Union([Search.SearchError, EnvironmentAuthorizationError]),
});
const WsExportCreateRpc = Rpc.make(WS_METHODS.exportCreate, {
  payload: Exports.ExportCreateInput,
  success: Exports.ExportResult,
  error: Schema.Union([Exports.ExportError, EnvironmentAuthorizationError]),
});
const WsExportValidateRpc = Rpc.make(WS_METHODS.exportValidate, {
  payload: Exports.ExportPathInput,
  success: Exports.ExportValidation,
  error: Schema.Union([Exports.ExportError, EnvironmentAuthorizationError]),
});
const WsExportListRpc = Rpc.make(WS_METHODS.exportList, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ exports: Schema.Array(Exports.ExportResult) }),
  error: Schema.Union([Exports.ExportError, EnvironmentAuthorizationError]),
});
const WsCommitmentsDeleteRpc = Rpc.make(WS_METHODS.commitmentsDelete, {
  payload: AgentWorkspace.CommitmentHistoryInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});

const WsProjectLabelsListRpc = Rpc.make(WS_METHODS.projectLabelsList, {
  payload: Schema.Struct({}),
  success: ProjectLabels.ProjectLabelListResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsSubscribeRpc = Rpc.make(WS_METHODS.projectLabelsSubscribe, {
  payload: Schema.Struct({}),
  success: ProjectLabels.ProjectLabelListResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
  stream: true,
});
const WsProjectLabelsCreateRpc = Rpc.make(WS_METHODS.projectLabelsCreate, {
  payload: ProjectLabels.ProjectLabelCreateInput,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsUpdateRpc = Rpc.make(WS_METHODS.projectLabelsUpdate, {
  payload: ProjectLabels.ProjectLabelUpdateInput,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsDeleteRpc = Rpc.make(WS_METHODS.projectLabelsDelete, {
  payload: ProjectLabels.ProjectLabelKey,
  success: ProjectLabels.ProjectLabelDeleteResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsArchiveRpc = Rpc.make(WS_METHODS.projectLabelsArchive, {
  payload: ProjectLabels.ProjectLabelKey,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsUnarchiveRpc = Rpc.make(WS_METHODS.projectLabelsUnarchive, {
  payload: ProjectLabels.ProjectLabelKey,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsLinkRepositoryRpc = Rpc.make(WS_METHODS.projectLabelsLinkRepository, {
  payload: ProjectLabels.ProjectLabelRepository,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsUnlinkRepositoryRpc = Rpc.make(WS_METHODS.projectLabelsUnlinkRepository, {
  payload: ProjectLabels.ProjectLabelRepository,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsGetThreadLabelsRpc = Rpc.make(WS_METHODS.projectLabelsGetThreadLabels, {
  payload: ProjectLabels.ThreadProjectLabelsInput,
  success: ProjectLabels.ThreadProjectLabelsResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsSubscribeThreadLabelsRpc = Rpc.make(
  WS_METHODS.projectLabelsSubscribeThreadLabels,
  {
    payload: ProjectLabels.ThreadProjectLabelsInput,
    success: ProjectLabels.ThreadProjectLabelsResult,
    error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
    stream: true,
  },
);
/** Confirmed tags of every live thread, for list surfaces such as the sidebar. */
const WsProjectLabelsSubscribeConfirmedThreadLabelsRpc = Rpc.make(
  WS_METHODS.projectLabelsSubscribeConfirmedThreadLabels,
  {
    payload: Schema.Struct({}),
    success: ProjectLabels.ThreadProjectLabelsResult,
    error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
    stream: true,
  },
);
const WsProjectLabelsMoveThreadRpc = Rpc.make(WS_METHODS.projectLabelsMoveThread, {
  payload: ProjectLabels.MoveThreadProjectFolderInput,
  success: ProjectLabels.ThreadProjectFolderResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsForkThreadToProjectRpc = Rpc.make(
  WS_METHODS.projectLabelsForkThreadToProject,
  {
    payload: ProjectLabels.ForkThreadToProjectInput,
    success: ProjectLabels.ForkThreadToProjectResult,
    error: Schema.Union([
      ProjectLabels.ProjectLabelError,
      OrchestrationDispatchCommandError,
      EnvironmentAuthorizationError,
    ]),
  },
);
const WsProjectLabelsSetThreadLabelsRpc = Rpc.make(WS_METHODS.projectLabelsSetThreadLabels, {
  payload: ProjectLabels.SetThreadProjectLabelsInput,
  success: ProjectLabels.ThreadProjectLabelsResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsLinkSourceRpc = Rpc.make(WS_METHODS.projectLabelsLinkSource, {
  payload: ProjectLabels.ProjectLabelSourceLinkInput,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsUnlinkSourceRpc = Rpc.make(WS_METHODS.projectLabelsUnlinkSource, {
  payload: ProjectLabels.ProjectLabelSourceLinkInput,
  success: ProjectLabels.ProjectLabelMutationResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsSearchOwnerRepositoriesRpc = Rpc.make(
  WS_METHODS.projectLabelsSearchOwnerRepositories,
  {
    payload: ProjectLabels.ProjectLabelOwnerRepositorySearchInput,
    success: ProjectLabels.ProjectLabelOwnerRepositorySearchResult,
    error: Schema.Union([
      ProjectLabels.ProjectLabelError,
      ProjectLabels.ProjectLabelOwnerSearchError,
      EnvironmentAuthorizationError,
    ]),
  },
);
// Clone-backed repository creation filed in a project. `start` returns once
// the project exists and the clone is running; progress arrives on the
// project-clone subscription like any other clone.
const WsProjectLabelsCloneRepositoryRpc = Rpc.make(WS_METHODS.projectLabelsCloneRepository, {
  payload: ProjectLabels.ProjectLabelCloneRepositoryInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    ProjectLabels.ProjectLabelError,
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});
const WsProjectLabelsListResourcesRpc = Rpc.make(WS_METHODS.projectLabelsListResources, {
  payload: ProjectLabels.ProjectLabelKey,
  success: ProjectLabels.ProjectLabelListResourcesResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsSubscribeResourcesRpc = Rpc.make(WS_METHODS.projectLabelsSubscribeResources, {
  payload: ProjectLabels.ProjectLabelKey,
  success: ProjectLabels.ProjectLabelListResourcesResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
  stream: true,
});
const WsProjectLabelsAddResourceRpc = Rpc.make(WS_METHODS.projectLabelsAddResource, {
  payload: ProjectLabels.ProjectLabelAddResourceInput,
  success: ProjectLabels.ProjectLabelAddResourceResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsRemoveResourceRpc = Rpc.make(WS_METHODS.projectLabelsRemoveResource, {
  payload: ProjectLabels.ProjectLabelRemoveResourceInput,
  success: ProjectLabels.ProjectLabelRemoveResourceResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
const WsProjectLabelsReadResourceRpc = Rpc.make(WS_METHODS.projectLabelsReadResource, {
  payload: ProjectLabels.ProjectLabelReadResourceInput,
  success: ProjectLabels.ProjectLabelReadResourceResult,
  error: Schema.Union([ProjectLabels.ProjectLabelError, EnvironmentAuthorizationError]),
});
// The project's own chat, created on first call and stable afterwards.
const WsProjectLabelsEnsureProjectChatRpc = Rpc.make(WS_METHODS.projectLabelsEnsureProjectChat, {
  payload: ProjectLabels.ProjectChatEnsureInput,
  success: ProjectLabels.ProjectChatEnsureResult,
  error: Schema.Union([
    ProjectLabels.ProjectLabelError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});
const WsWorkStartRpc = Rpc.make(WS_METHODS.workStart, {
  payload: Work.WorkStartInput,
  success: Work.WorkStartResult,
  error: Schema.Union([Work.WorkHandoffError, EnvironmentAuthorizationError]),
});

const WsAgentsApprovalsListRpc = Rpc.make(WS_METHODS.agentsApprovalsList, {
  payload: AgentWorkspace.AgentApprovalListInput,
  success: AgentWorkspace.AgentApprovalListResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsRequestApprovalRpc = Rpc.make(WS_METHODS.agentsRequestApproval, {
  payload: AgentWorkspace.AgentApprovalRequestInput,
  success: AgentWorkspace.AgentApprovalResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsApproveRpc = Rpc.make(WS_METHODS.agentsApprove, {
  payload: AgentWorkspace.AgentApprovalKey,
  success: AgentWorkspace.AgentApprovalResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsRejectRpc = Rpc.make(WS_METHODS.agentsReject, {
  payload: AgentWorkspace.AgentApprovalKey,
  success: AgentWorkspace.AgentApprovalResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsStartWorkRpc = Rpc.make(WS_METHODS.agentsStartWork, {
  payload: AgentWorkspace.AgentStartWorkInput,
  success: AgentWorkspace.AgentStartWorkResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsActivityRpc = Rpc.make(WS_METHODS.agentsActivity, {
  payload: AgentWorkspace.AgentActivityInput,
  success: AgentWorkspace.AgentActivityResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsIntegrationsListRpc = Rpc.make(WS_METHODS.integrationsList, {
  payload: Schema.Struct({}),
  success: Integrations.IntegrationListResult,
  error: Schema.Union([Integrations.IntegrationError, EnvironmentAuthorizationError]),
});
const WsIntegrationsCreateRpc = Rpc.make(WS_METHODS.integrationsCreate, {
  payload: Integrations.IntegrationCreateInput,
  success: Integrations.IntegrationMutationResult,
  error: Schema.Union([Integrations.IntegrationError, EnvironmentAuthorizationError]),
});
const WsIntegrationsUpdateRpc = Rpc.make(WS_METHODS.integrationsUpdate, {
  payload: Integrations.IntegrationUpdateInput,
  success: Integrations.IntegrationMutationResult,
  error: Schema.Union([Integrations.IntegrationError, EnvironmentAuthorizationError]),
});
const WsIntegrationsDeleteRpc = Rpc.make(WS_METHODS.integrationsDelete, {
  payload: Integrations.IntegrationKey,
  success: Integrations.IntegrationDeleteResult,
  error: Schema.Union([Integrations.IntegrationError, EnvironmentAuthorizationError]),
});
const WsIntegrationsTestConnectionRpc = Rpc.make(WS_METHODS.integrationsTestConnection, {
  payload: Integrations.IntegrationKey,
  success: Integrations.IntegrationTestResult,
  error: Schema.Union([Integrations.IntegrationError, EnvironmentAuthorizationError]),
});

const machineErrors = Schema.Union([Machines.MachineError, EnvironmentAuthorizationError]);
const WsMachinesListRpc = Rpc.make(WS_METHODS.machinesList, {
  payload: Schema.Struct({}),
  success: Machines.MachineListResult,
  error: machineErrors,
});
const WsMachinesSubscribeRpc = Rpc.make(WS_METHODS.machinesSubscribe, {
  payload: Schema.Struct({}),
  success: Machines.MachineListResult,
  error: machineErrors,
  stream: true,
});
const WsMachinesUpdateRpc = Rpc.make(WS_METHODS.machinesUpdate, {
  payload: Machines.MachineUpdateInput,
  success: Machines.MachineListResult,
  error: machineErrors,
});
const WsMachinesPrepareJoinRpc = Rpc.make(WS_METHODS.machinesPrepareJoin, {
  payload: Schema.Struct({}),
  success: Machines.MachinePeerIdentity,
  error: machineErrors,
});
const WsMachinesCreatePeerGrantRpc = Rpc.make(WS_METHODS.machinesCreatePeerGrant, {
  payload: Machines.MachineCreatePeerGrantInput,
  success: Machines.MachineJoinCode,
  error: machineErrors,
});
const WsMachinesJoinHubRpc = Rpc.make(WS_METHODS.machinesJoinHub, {
  payload: Machines.MachineJoinHubInput,
  success: Machines.MachineListResult,
  error: machineErrors,
});
const WsMachinesUnpairRpc = Rpc.make(WS_METHODS.machinesUnpair, {
  payload: Machines.MachineUnpairInput,
  success: Machines.MachineUnpairResult,
  error: machineErrors,
});

const WsFactsListRpc = Rpc.make(WS_METHODS.factsList, {
  payload: Facts.FactListInput,
  success: Facts.FactListResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsFactsCreateRpc = Rpc.make(WS_METHODS.factsCreate, {
  payload: Facts.FactCreateInput,
  success: Facts.FactResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsFactsUpdateRpc = Rpc.make(WS_METHODS.factsUpdate, {
  payload: Facts.FactUpdateInput,
  success: Facts.FactResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsFactsSupersedeRpc = Rpc.make(WS_METHODS.factsSupersede, {
  payload: Facts.FactSupersedeInput,
  success: Facts.FactResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsFactsRetractRpc = Rpc.make(WS_METHODS.factsRetract, {
  payload: Facts.FactKey,
  success: Facts.FactResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsFactsHistoryRpc = Rpc.make(WS_METHODS.factsHistory, {
  payload: Facts.FactKey,
  success: Facts.FactHistoryResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsContextForRunRpc = Rpc.make(WS_METHODS.contextForRun, {
  payload: Facts.ContextForRunInput,
  success: Facts.ContextForRunResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsContextSettingsRpc = Rpc.make(WS_METHODS.contextSettings, {
  payload: Facts.ContextThreadInput,
  success: Facts.ContextSettingsResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});
const WsContextSetEnabledRpc = Rpc.make(WS_METHODS.contextSetEnabled, {
  payload: Facts.ContextSetEnabledInput,
  success: Facts.ContextSettingsResult,
  error: Schema.Union([Facts.FactError, EnvironmentAuthorizationError]),
});

const WsCommitmentsListRpc = Rpc.make(WS_METHODS.commitmentsList, {
  payload: AgentWorkspace.CommitmentListInput,
  success: AgentWorkspace.CommitmentListResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsCommitmentsCreateRpc = Rpc.make(WS_METHODS.commitmentsCreate, {
  payload: AgentWorkspace.CommitmentCreateInput,
  success: AgentWorkspace.CommitmentResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsCommitmentsUpdateStatusRpc = Rpc.make(WS_METHODS.commitmentsUpdateStatus, {
  payload: AgentWorkspace.CommitmentStatusInput,
  success: AgentWorkspace.CommitmentResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsCommitmentsConfirmRpc = Rpc.make(WS_METHODS.commitmentsConfirm, {
  payload: AgentWorkspace.CommitmentKey,
  success: AgentWorkspace.CommitmentResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsCommitmentsDismissRpc = Rpc.make(WS_METHODS.commitmentsDismiss, {
  payload: AgentWorkspace.CommitmentKey,
  success: AgentWorkspace.CommitmentResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsCommitmentsHistoryRpc = Rpc.make(WS_METHODS.commitmentsHistory, {
  payload: AgentWorkspace.CommitmentHistoryInput,
  success: AgentWorkspace.CommitmentHistoryResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsListRpc = Rpc.make(WS_METHODS.agentsList, {
  payload: Schema.Struct({}),
  success: Agents.AgentListResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsSubscribeRpc = Rpc.make(WS_METHODS.agentsSubscribe, {
  payload: Schema.Struct({}),
  success: Agents.AgentListResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
  stream: true,
});
const WsAgentsUpsertRpc = Rpc.make(WS_METHODS.agentsUpsert, {
  payload: Agents.AgentUpsertInput,
  success: Agents.AgentMutationResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsDeleteRpc = Rpc.make(WS_METHODS.agentsDelete, {
  payload: Agents.AgentKey,
  success: Agents.AgentDeleteResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsSendRpc = Rpc.make(WS_METHODS.agentsSend, {
  payload: Agents.AgentSendInput,
  success: Agents.AgentSendResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsMarkReadRpc = Rpc.make(WS_METHODS.agentsMarkRead, {
  payload: Agents.AgentMarkReadInput,
  success: Agents.AgentMarkReadResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsSetProjectRpc = Rpc.make(WS_METHODS.agentsSetProject, {
  payload: Agents.AgentSetProjectInput,
  success: Agents.AgentMutationResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsMemoryListRpc = Rpc.make(WS_METHODS.agentsMemoryList, {
  payload: Agents.AgentMemoryListInput,
  success: Agents.AgentMemoryListResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsMemoryWriteRpc = Rpc.make(WS_METHODS.agentsMemoryWrite, {
  payload: Agents.AgentMemoryWriteInput,
  success: Agents.AgentMemoryWriteResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsMemoryForgetRpc = Rpc.make(WS_METHODS.agentsMemoryForget, {
  payload: Agents.AgentMemoryForgetInput,
  success: Agents.AgentDeleteResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsRunsRpc = Rpc.make(WS_METHODS.agentsRuns, {
  payload: Agents.AgentKey,
  success: Agents.AgentRunsResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});
const WsAgentsBuilderStartRpc = Rpc.make(WS_METHODS.agentsBuilderStart, {
  payload: AgentBuilder.AgentBuilderStartInput,
  success: AgentBuilder.AgentBuilderStartResult,
  error: Schema.Union([Agents.AgentError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListRpc = Rpc.make(WS_METHODS.scheduledTasksList, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

/** Streams the full scheduled-task list: one snapshot on subscribe, then a fresh list after every change. */
const WsScheduledTasksSubscribeRpc = Rpc.make(WS_METHODS.scheduledTasksSubscribe, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsScheduledTasksUpsertRpc = Rpc.make(WS_METHODS.scheduledTasksUpsert, {
  payload: ScheduledTaskUpsertInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSetEnabledRpc = Rpc.make(WS_METHODS.scheduledTasksSetEnabled, {
  payload: ScheduledTaskSetEnabledInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksDeleteRpc = Rpc.make(WS_METHODS.scheduledTasksDelete, {
  payload: ScheduledTaskDeleteInput,
  success: ScheduledTaskDeleteResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRunNowRpc = Rpc.make(WS_METHODS.scheduledTasksRunNow, {
  payload: ScheduledTaskRunNowInput,
  success: ScheduledTaskRunNowResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRotateWebhookTokenRpc = Rpc.make(
  WS_METHODS.scheduledTasksRotateWebhookToken,
  {
    payload: ScheduledTaskRotateWebhookTokenInput,
    success: ScheduledTaskMutationResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSecretsAnswerRequestRpc = Rpc.make(WS_METHODS.secretsAnswerRequest, {
  payload: SecretRequestAnswerInput,
  error: Schema.Union([SecretRequestError, EnvironmentAuthorizationError]),
});

const WsAccountsConnectRpc = Rpc.make(WS_METHODS.accountsConnect, {
  payload: Accounts.AccountThreadConnectInput,
  success: Accounts.AccountConnectResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsUseRpc = Rpc.make(WS_METHODS.accountsUse, {
  payload: Accounts.AccountThreadUseInput,
  success: Accounts.AccountUseResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsRemoveAccessRpc = Rpc.make(WS_METHODS.accountsRemoveAccess, {
  payload: Accounts.AccountRemoveAccessInput,
  success: Accounts.AccountRemoveAccessResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsListRpc = Rpc.make(WS_METHODS.accountsList, {
  payload: Accounts.AccountsListInput,
  success: Accounts.AccountsListResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsGetRpc = Rpc.make(WS_METHODS.accountsGet, {
  payload: Accounts.AccountKeyInput,
  success: Accounts.AccountResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsCreateRpc = Rpc.make(WS_METHODS.accountsCreate, {
  payload: Accounts.AccountCreateInput,
  success: Accounts.AccountResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsUpdateRpc = Rpc.make(WS_METHODS.accountsUpdate, {
  payload: Accounts.AccountUpdateInput,
  success: Accounts.AccountResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsAccountsDisconnectRpc = Rpc.make(WS_METHODS.accountsDisconnect, {
  payload: Accounts.AccountKeyInput,
  success: Accounts.AccountDisconnectResult,
  error: Schema.Union([Accounts.AccountError, EnvironmentAuthorizationError]),
});
const WsVaultListRpc = Rpc.make(WS_METHODS.vaultList, {
  payload: Vault.VaultListInput,
  success: Vault.VaultListResult,
  error: Schema.Union([Vault.VaultError, EnvironmentAuthorizationError]),
});
const WsVaultCreateRpc = Rpc.make(WS_METHODS.vaultCreate, {
  payload: Vault.VaultCreateInput,
  success: Vault.VaultItemResult,
  error: Schema.Union([Vault.VaultError, EnvironmentAuthorizationError]),
});
const WsVaultUpdateRpc = Rpc.make(WS_METHODS.vaultUpdate, {
  payload: Vault.VaultUpdateInput,
  success: Vault.VaultItemResult,
  error: Schema.Union([Vault.VaultError, EnvironmentAuthorizationError]),
});
const WsVaultDeleteRpc = Rpc.make(WS_METHODS.vaultDelete, {
  payload: Vault.VaultDeleteInput,
  success: Vault.VaultDeleteResult,
  error: Schema.Union([Vault.VaultError, EnvironmentAuthorizationError]),
});
const WsVaultUsageRpc = Rpc.make(WS_METHODS.vaultUsage, {
  payload: Vault.VaultUsageListInput,
  success: Vault.VaultUsageListResult,
  error: Schema.Union([Vault.VaultError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListWebhookDeliveriesRpc = Rpc.make(
  WS_METHODS.scheduledTasksListWebhookDeliveries,
  {
    payload: ScheduledTaskListWebhookDeliveriesInput,
    success: ScheduledTaskListWebhookDeliveriesResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsScheduledTasksGetWebhookDeliveryRpc = Rpc.make(
  WS_METHODS.scheduledTasksGetWebhookDelivery,
  {
    payload: ScheduledTaskGetWebhookDeliveryInput,
    success: ScheduledTaskGetWebhookDeliveryResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Checks the connection's scopes against the scope each RPC declares, before
 * the handler runs. Every RPC in `WsRpcGroup` carries it, so a handler cannot
 * be added without authorization.
 */
export class RpcScopeAuthorization extends RpcMiddleware.Service<RpcScopeAuthorization>()(
  "t3/contracts/RpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsChatGptReconnectProfileRpc,
  WsChatGptImportProfileRpc,
  WsChatGptHandoffSubscribeRpc,
  WsCodexAuthCallbackSubscribeRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerRunStorageCleanupRpc,
  WsServerGetStorageCleanupReportRpc,
  WsServerGetDatabaseStorageRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerCheckOtlpEndpointRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsSearchQueryRpc,
  WsExportCreateRpc,
  WsExportValidateRpc,
  WsExportListRpc,
  WsCommitmentsDeleteRpc,
  WsProjectLabelsListRpc,
  WsProjectLabelsSubscribeRpc,
  WsProjectLabelsCreateRpc,
  WsProjectLabelsUpdateRpc,
  WsProjectLabelsDeleteRpc,
  WsProjectLabelsArchiveRpc,
  WsProjectLabelsUnarchiveRpc,
  WsProjectLabelsLinkRepositoryRpc,
  WsProjectLabelsUnlinkRepositoryRpc,
  WsProjectLabelsGetThreadLabelsRpc,
  WsProjectLabelsSubscribeThreadLabelsRpc,
  WsProjectLabelsSubscribeConfirmedThreadLabelsRpc,
  WsProjectLabelsMoveThreadRpc,
  WsProjectLabelsForkThreadToProjectRpc,
  WsProjectLabelsSetThreadLabelsRpc,
  WsProjectLabelsLinkSourceRpc,
  WsProjectLabelsUnlinkSourceRpc,
  WsProjectLabelsSearchOwnerRepositoriesRpc,
  WsProjectLabelsCloneRepositoryRpc,
  WsProjectLabelsListResourcesRpc,
  WsProjectLabelsSubscribeResourcesRpc,
  WsProjectLabelsAddResourceRpc,
  WsProjectLabelsRemoveResourceRpc,
  WsProjectLabelsReadResourceRpc,
  WsProjectLabelsEnsureProjectChatRpc,
  WsWorkStartRpc,
  WsAgentsApprovalsListRpc,
  WsAgentsRequestApprovalRpc,
  WsAgentsApproveRpc,
  WsAgentsRejectRpc,
  WsAgentsStartWorkRpc,
  WsAgentsActivityRpc,
  WsIntegrationsListRpc,
  WsIntegrationsCreateRpc,
  WsIntegrationsUpdateRpc,
  WsIntegrationsDeleteRpc,
  WsIntegrationsTestConnectionRpc,
  WsMachinesListRpc,
  WsMachinesSubscribeRpc,
  WsMachinesUpdateRpc,
  WsMachinesPrepareJoinRpc,
  WsMachinesCreatePeerGrantRpc,
  WsMachinesJoinHubRpc,
  WsMachinesUnpairRpc,
  WsFactsListRpc,
  WsFactsCreateRpc,
  WsFactsUpdateRpc,
  WsFactsSupersedeRpc,
  WsFactsRetractRpc,
  WsFactsHistoryRpc,
  WsContextForRunRpc,
  WsContextSettingsRpc,
  WsContextSetEnabledRpc,
  WsCommitmentsListRpc,
  WsCommitmentsCreateRpc,
  WsCommitmentsUpdateStatusRpc,
  WsCommitmentsConfirmRpc,
  WsCommitmentsDismissRpc,
  WsCommitmentsHistoryRpc,
  WsAgentsListRpc,
  WsAgentsSubscribeRpc,
  WsAgentsUpsertRpc,
  WsAgentsDeleteRpc,
  WsAgentsSendRpc,
  WsAgentsMarkReadRpc,
  WsAgentsSetProjectRpc,
  WsAgentsMemoryListRpc,
  WsAgentsMemoryWriteRpc,
  WsAgentsMemoryForgetRpc,
  WsAgentsRunsRpc,
  WsAgentsBuilderStartRpc,
  WsScheduledTasksListRpc,
  WsScheduledTasksSubscribeRpc,
  WsScheduledTasksUpsertRpc,
  WsScheduledTasksSetEnabledRpc,
  WsScheduledTasksDeleteRpc,
  WsScheduledTasksRunNowRpc,
  WsScheduledTasksRotateWebhookTokenRpc,
  WsSecretsAnswerRequestRpc,
  WsAccountsConnectRpc,
  WsAccountsUseRpc,
  WsAccountsRemoveAccessRpc,
  WsAccountsListRpc,
  WsAccountsGetRpc,
  WsAccountsCreateRpc,
  WsAccountsUpdateRpc,
  WsAccountsDisconnectRpc,
  WsVaultListRpc,
  WsVaultCreateRpc,
  WsVaultUpdateRpc,
  WsVaultDeleteRpc,
  WsVaultUsageRpc,
  WsScheduledTasksListWebhookDeliveriesRpc,
  WsScheduledTasksGetWebhookDeliveryRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsChecksRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsReviewGuideRpc,
  WsPullRequestsGenerateReviewGuideRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReportStateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsEnsureScratchRpc,
  WsProjectsCreateNewRpc,
  WsProjectsWriteFileRpc,
  WsProjectsMutateRpc,
  WsShellRevealInFileManagerRpc,
  WsFilesystemBrowseRpc,
  WsFilesystemGetMetadataRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsT3ImportStatusRpc,
  WsT3ImportScanRpc,
  WsT3ImportRunRpc,
  WsT3ImportCancelRpc,
  WsAssetsCreateUrlRpc,
  WsAssetsPersistChatAttachmentsRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsMcpAppsCallToolRpc,
  WsMcpAppsToolInfoRpc,
  WsMcpAppsReadResourceRpc,
  WsMcpAppsUpdateModelContextRpc,
  WsVisualStateGetRpc,
  WsVisualStateSetRpc,
  WsVisualStateSubmitRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalObserveRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalKillRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewAdjustRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewClearProfileRpc,
  WsPreviewReportProfilesRpc,
  WsPreviewReportShownRpc,
  WsPreviewReportStatusRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationV2DispatchCommandRpc,
  WsOrchestrationV2GetWorkflowScriptRpc,
  WsOrchestrationV2StopWorkflowRpc,
  WsOrchestrationV2GetTurnItemRpc,
  WsOrchestrationV2GetTurnDiffRpc,
  WsOrchestrationV2GetFullThreadDiffRpc,
  WsOrchestrationV2SearchThreadsRpc,
  WsOrchestrationV2SearchThreadRpc,
  WsOrchestrationV2SearchThreadStreamRpc,
  WsOrchestrationV2GetArchivedShellSnapshotRpc,
  WsOrchestrationV2GetThreadProjectionRpc,
  WsOrchestrationV2LaunchThreadRpc,
  WsOrchestrationV2SubscribeArchivedShellRpc,
  WsOrchestrationV2SubscribeShellRpc,
  WsOrchestrationV2SubscribeThreadRpc,
  WsOrchestrationV2SubscribeCommandOutputRpc,
).middleware(RpcScopeAuthorization);

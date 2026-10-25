import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.searchQuery]: AuthOrchestrationReadScope,
  [WS_METHODS.exportCreate]: AuthSettingsWriteScope,
  [WS_METHODS.exportValidate]: AuthSettingsWriteScope,
  [WS_METHODS.exportList]: AuthSettingsWriteScope,
  // Importing writes projects, threads and settings, so even its status needs the settings grant.
  [WS_METHODS.t3ImportStatus]: AuthSettingsWriteScope,
  [WS_METHODS.t3ImportScan]: AuthSettingsWriteScope,
  [WS_METHODS.t3ImportRun]: AuthSettingsWriteScope,
  [WS_METHODS.t3ImportCancel]: AuthSettingsWriteScope,
  [WS_METHODS.commitmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.visualStateGet]: AuthOrchestrationReadScope,
  [WS_METHODS.visualStateSet]: AuthOrchestrationOperateScope,
  [WS_METHODS.visualStateSubmit]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.projectLabelsCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectLabelsCheckoutRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectLabelsRemoveCheckout]: AuthSourceControlWriteScope,
  [WS_METHODS.projectLabelsAdoptRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.projectLabelsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsArchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsUnarchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsLinkRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsUnlinkRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsLinkSource]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsUnlinkSource]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsMoveThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsMoveToMachine]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesMoveThreads]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesForkThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesMoveAllThreads]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesPreviewMoveThreads]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesPreviewMoveAllThreads]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsPreviewMoveToMachine]: AuthOrchestrationOperateScope,
  [WS_METHODS.machinesAdoptThreads]: AuthAccessWriteScope,
  [WS_METHODS.projectLabelsForkThreadToProject]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsSetThreadLabels]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsAddResource]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsRemoveResource]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsEnsureProjectChat]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsAdoptOrphanFolder]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectLabelsRemoveOrphanFolder]: AuthOrchestrationOperateScope,
  [WS_METHODS.workStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsRequestApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsApprove]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsReject]: AuthOrchestrationOperateScope,
  // Seeing what a thread waits on is a read; deciding it is agents.approve / agents.reject.
  [WS_METHODS.threadApprovalsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.agentsStartWork]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsPreviewNative]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsImportNative]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsList]: AuthOrchestrationReadScope,
  // Creating or changing an integration hands agents a new credentialed
  // upstream, and testing one spends a resolved credential on the network.
  [WS_METHODS.integrationsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsTestConnection]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsSubscribe]: AuthOrchestrationReadScope,
  // Signing in grants agents a new upstream account.
  [WS_METHODS.integrationsBeginSignIn]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsConnectFromCatalog]: AuthOrchestrationOperateScope,
  // Saving a client secret or key writes the vault and the integration, like vault.create.
  [WS_METHODS.integrationsSaveOAuthClient]: AuthOrchestrationOperateScope,
  [WS_METHODS.integrationsSaveApiKey]: AuthOrchestrationOperateScope,
  // Installing uv puts software on this machine, like installing a provider CLI.
  [WS_METHODS.integrationsInstallRuntime]: AuthProvidersManageScope,
  // The composer's Sources picker runs for every paired client that can read threads.
  [WS_METHODS.integrationsSubscribeSources]: AuthOrchestrationReadScope,
  [WS_METHODS.machineSecurityStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.machinesList]: AuthOrchestrationReadScope,
  [WS_METHODS.syncStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.machinesCatalog]: AuthOrchestrationReadScope,
  [WS_METHODS.machinesSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.machinesUpdate]: AuthSettingsWriteScope,
  // Pairing hands another server a standing credential to this one, or makes
  // this server hold one for another: access management, like pairing links.
  [WS_METHODS.machinesPrepareJoin]: AuthAccessWriteScope,
  [WS_METHODS.machinesCreatePeerGrant]: AuthAccessWriteScope,
  [WS_METHODS.machinesJoinHub]: AuthAccessWriteScope,
  [WS_METHODS.machinesUnpair]: AuthAccessWriteScope,
  // Setup installs software and puts this server on the tailnet, and its
  // status carries the one-time Tailscale sign-in link: access management too.
  [WS_METHODS.machinesSetupStatus]: AuthAccessWriteScope,
  [WS_METHODS.machinesSetupSubscribe]: AuthAccessWriteScope,
  [WS_METHODS.machinesSetupRunStep]: AuthAccessWriteScope,
  [WS_METHODS.machinesSetupDisableServe]: AuthAccessWriteScope,
  [WS_METHODS.factsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.factsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.factsSupersede]: AuthOrchestrationOperateScope,
  [WS_METHODS.factsRetract]: AuthOrchestrationOperateScope,
  [WS_METHODS.contextSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.commitmentsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.commitmentsUpdateStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.commitmentsConfirm]: AuthOrchestrationOperateScope,
  [WS_METHODS.commitmentsDismiss]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsBuilderStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsMarkRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsSetProject]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsMemoryForget]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  // Vault metadata is owner-visible; writes change stored secrets.
  [WS_METHODS.accountsConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.accountsUse]: AuthOrchestrationOperateScope,
  [WS_METHODS.accountsRemoveAccess]: AuthOrchestrationOperateScope,
  [WS_METHODS.accountsList]: AuthOrchestrationReadScope,
  [WS_METHODS.accountsGet]: AuthOrchestrationReadScope,
  [WS_METHODS.accountsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.accountsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.accountsDisconnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.vaultList]: AuthOrchestrationReadScope,
  [WS_METHODS.vaultUsage]: AuthOrchestrationReadScope,
  [WS_METHODS.vaultCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.vaultUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.vaultDelete]: AuthOrchestrationOperateScope,
  // Sharing makes another machine able to decrypt every shared item: access
  // management, like pairing. Agents have no tool for it.
  [WS_METHODS.vaultSetPeerSharing]: AuthAccessWriteScope,
  [WS_METHODS.vaultSharingStatus]: AuthAccessReadScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Continuing on another provider starts a turn, like sending a message.
  [ORCHESTRATION_V2_WS_METHODS.acceptUsageLimitHandoff]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;
export type ClientGuardedReadRpcTag = {
  [Tag in ClientGuardedRpcTag]: (typeof CLIENT_GUARDED_RPC_SCOPES)[Tag] extends `${string}:read`
    ? Tag
    : never;
}[ClientGuardedRpcTag];

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}

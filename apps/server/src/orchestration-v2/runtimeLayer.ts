import * as AccountConnections from "../accounts/AccountConnections.ts";
import * as AccountAccess from "../accounts/AccountAccess.ts";
import * as CliCredentials from "../accounts/CliCredentials.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VisualStates from "../htmlRender/VisualState.ts";
import * as GlobalSearch from "../search/GlobalSearch.ts";
import * as Facts from "../context/FactService.ts";
import * as Integrations from "../integrations/Integrations.ts";
import * as LocalIntegrations from "../integrations/local/LocalIntegrations.ts";
import * as LocalMcpRunner from "../integrations/local/LocalMcpRunner.ts";
import * as IntegrationCredentials from "../integrations/IntegrationCredentials.ts";
import * as IntegrationTokens from "../integrations/IntegrationTokens.ts";
import * as Retrieval from "../context/ContextRetrievalService.ts";
import * as Exports from "../export/ExportService.ts";
import * as AgentEvents from "../agents/AgentEventBus.ts";
import * as AgentEventReactor from "../agents/AgentEventReactor.ts";
import * as ProjectLabels from "../projectLabels/ProjectLabelService.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectHome from "../projectLabels/ProjectHome.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as WorkHandoff from "../work/WorkHandoffService.ts";
import * as AgentWorkspace from "../agents/AgentWorkspaceService.ts";
import * as ApprovalChanges from "../agents/ApprovalChanges.ts";
import * as AgentMcpPolicy from "../agents/AgentMcpPolicy.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Agents from "../agents/AgentService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as UsageLimitHandoff from "./UsageLimitHandoff.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as T3Import from "../t3Import/T3ImportService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as RepositoryIconResolver from "../project/RepositoryIconResolver.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as MachinesTurnContext from "./MachinesTurnContext.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as RemoteThreadCommands from "./RemoteThreadCommands.ts";
import * as RemoteThreadLaunch from "./RemoteThreadLaunch.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadLifecycleService from "./ThreadLifecycleService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Vault from "../vault/Vault.ts";
import * as Accounts from "../accounts/Accounts.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** The shared application event log and its command receipts. */
export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

// Shared so every consumer gets the one files index and watcher.
const layerProjectFilesProvided = ProjectFiles.layer.pipe(Layer.provide(ProjectLabelFolders.layer));

const layerRuntimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectLabelFolders.layer,
      // Nested: a merge would leave the files layer's folder requirement dangling.
      layerProjectFilesProvided,
    ),
  ),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerEventSinkProvided = layerEventSink;
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSinkProvided),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const layerProviderAdapterRegistryProvided =
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry;
const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(layerProviderAdapterRegistryProvided),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSinkProvided, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCommandOutputHubProvided,
      layerProviderAdapterRegistryProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(AgentStore.layer),
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      // Same reference as the machine link's, which registers the reader.
      MachinesTurnContext.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
    ),
  ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSinkProvided,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      layerProviderAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      ProviderContinuationRequests.layer,
      // Same reference as thread sync's router, which registers the forwarder.
      RemoteThreadCommands.layer,
      RemoteThreadLaunch.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
);
// Built once and shared: named projects file into labels through the same
// instance direct consumers use, so filing notifications reach every
// subscriber. Layers memoize by identity, so providing this twice below
// still constructs one service.
const layerProjectLabelsProvided = ProjectLabels.layer.pipe(
  Layer.provide(Layer.mergeAll(layerEventInfrastructure, ProjectLabelFolders.layer)),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
  Layer.provide(Layer.mergeAll(layerProjectLabelsProvided, ProjectLabelFolders.layer)),
);
// Scratch chats from T3 Code file under "No project", which ManagedProjectFolders owns.
const layerT3ImportProvided = T3Import.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerProjectService, layerEventSinkProvided, layerManagedProjectFoldersProvided),
  ),
);
const layerRepositoryCheckoutProvided = RepositoryCheckout.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerProjectService, layerProjectLabelsProvided, ProjectLabelFolders.layer),
  ),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerProjectLabelsProvided,
      layerRepositoryCheckoutProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
      // Same reference as thread sync's launch router, which registers the launcher.
      RemoteThreadLaunch.layer,
    ),
  ),
);
const layerWorkHandoffProvided = WorkHandoff.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerProjectService,
      layerManagedProjectFoldersProvided,
      AgentStore.layer,
    ),
  ),
);
const layerThreadLifecycleProvided = ThreadLifecycleService.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
// One signal shared by every writer of agent_approvals and both approval streams.
const layerApprovalChanges = ApprovalChanges.layer;
export const layerVaultProvided = Vault.layer.pipe(
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerProjectFilesProvided),
  Layer.provide(layerApprovalChanges),
);
const layerIntegrationCredentials = IntegrationCredentials.layer.pipe(
  Layer.provide(layerVaultProvided),
);
const layerLocalIntegrationsProvided = LocalIntegrations.layer.pipe(
  Layer.provide(LocalMcpRunner.layer),
  Layer.provide(layerIntegrationCredentials),
);
const layerIntegrationsProvided = Integrations.layer.pipe(
  Layer.provide(layerIntegrationCredentials),
  Layer.provide(IntegrationTokens.layer.pipe(Layer.provide(layerVaultProvided))),
  Layer.provide(layerLocalIntegrationsProvided),
);
const layerAgentsProvided = Agents.layer.pipe(
  Layer.provide(RemoteThreadLaunch.layer),
  Layer.provide(
    Layer.mergeAll(
      AgentStore.layer,
      layerManagedProjectFoldersProvided,
      layerProjectLabelsProvided,
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      ProjectionStore.layer,
      layerEventSinkProvided,
      layerApprovalChanges,
    ),
  ),
);
const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(RemoteThreadLaunch.layer),
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerSecretRequestsProvided,
      layerAgentsProvided,
      AgentStore.layer,
    ),
  ),
);
const layerAgentEventsProvided = AgentEvents.layer.pipe(
  Layer.provide(Layer.mergeAll(layerAgentsProvided, layerScheduledTaskProvided, AgentStore.layer)),
);
const layerAgentEventReactorProvided = AgentEventReactor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAgentEventsProvided,
      ProjectionStore.layer,
      layerEventStoreProvided,
      layerManagedProjectFoldersProvided,
    ),
  ),
);
const layerAccountsProvided = Accounts.layer.pipe(Layer.provide(layerVaultProvided));
const layerAccountAccessProvided = AccountAccess.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAccountsProvided,
      AgentStore.layer,
      layerThreadManagementProvided,
      layerProjectFilesProvided,
      layerApprovalChanges,
    ).pipe(Layer.provideMerge(ServerEnvironment.layerIdentity)),
  ),
);
const layerCliCredentialsProvided = CliCredentials.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerAccountAccessProvided, layerVaultProvided, ProcessRunner.layer).pipe(
      Layer.provideMerge(ServerEnvironment.layerIdentity),
    ),
  ),
);
const layerAccountConnectionsProvided = AccountConnections.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAccountsProvided,
      layerAccountAccessProvided,
      layerCliCredentialsProvided,
      layerSecretRequestsProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerAgentWorkspaceProvided = AgentWorkspace.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentStore.layer,
      layerAgentsProvided,
      layerWorkHandoffProvided,
      layerAccountAccessProvided,
      layerScheduledTaskProvided,
      layerIntegrationsProvided,
      layerApprovalChanges,
    ),
  ),
);
const layerAgentMcpPolicyProvided = AgentMcpPolicy.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentStore.layer,
      layerProjectFilesProvided,
      layerAgentWorkspaceProvided,
      layerThreadManagementProvided,
      layerIntegrationsProvided,
    ),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerThreadManagementProvided, ProjectStore.layer, TextGeneration.layer),
  ),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerCommandOutputHubProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

const layerProductionBase = Layer.mergeAll(
  RemoteThreadLaunch.layer,
  layerLocalIntegrationsProvided,
  Facts.layer,
  layerIntegrationsProvided,
  Retrieval.layer,
  layer.pipe(Layer.provide(layerProjectService)),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerRepositoryCheckoutProvided,
  RepositoryIconResolver.layer,
  RepositoryCheckout.layerRelocation.pipe(
    Layer.provide(Layer.mergeAll(layerRepositoryCheckoutProvided, layerProjectLabelsProvided)),
  ),
  layerWorkHandoffProvided,
  layerThreadLifecycleProvided,
  layerAgentsProvided,
  GlobalSearch.layer.pipe(Layer.provide(AgentStore.layer)),
  Exports.layer,
  layerProjectLabelsProvided,
  ProjectLabelFolders.layer,
  layerProjectFilesProvided,
  ProjectHome.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerProjectLabelsProvided,
        layerProjectFilesProvided,
        layerThreadLaunchProvided,
        layerThreadManagementProvided,
        layerManagedProjectFoldersProvided,
        ProjectStore.layer,
      ),
    ),
  ),
  layerAgentWorkspaceProvided,
  layerAgentEventReactorProvided,
  layerAgentMcpPolicyProvided,
  AgentStore.layer,
  layerScheduledTaskProvided,
  layerSecretRequestsProvided,
  layerVaultProvided,
  layerAccountsProvided,
  layerAccountAccessProvided,
  layerCliCredentialsProvided,
  layerAccountConnectionsProvided,
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(AgentStore.layer),
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        UsageLimitHandoff.layer.pipe(Layer.provide(layerThreadManagementProvided)),
      ),
    ),
  ),
  UsageLimitHandoff.layer.pipe(Layer.provide(layerThreadManagementProvided)),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionImporterProvided,
  layerT3ImportProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(Layer.provide(Scheduler.layer), Layer.provideMerge(layerEventInfrastructure));

// Visual states read the thread projection and dispatch through thread
// management, so they are built from the merged runtime that provides them.
// Merging the bare layer would re-export thread management as an input
// requirement, which leaks into every CLI command through runServer.
const layerVisualStatesProvided = VisualStates.layer.pipe(Layer.provide(layerProductionBase));

export const layerProduction = Layer.mergeAll(layerProductionBase, layerVisualStatesProvided).pipe(
  Layer.provide(ServerEnvironment.layerIdentity),
);

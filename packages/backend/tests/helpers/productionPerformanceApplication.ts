import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
import { withO2Closure, o2Ports } from './o2Closure'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { memorySystemAgentBindingForTest } from './memoryDistill'
import { join } from 'node:path'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import { composeLocalHttpAuthentication } from '@/modules/identity-access/composition/authentication'
import { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import { composeFileApplicationConfigurationQueries } from '@/modules/system-operations/composition'
import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
// RFC-359 AC11: the original HTTP transport around the real measured owner graph.
// Construction completes before callers time app.request and consume its response.
import type { Hono } from 'hono'

import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition/commandContext'
import {
  createClarifyDecisionCommand,
  createQuestionDispatchCommand,
  createReviewDecisionCommand,
} from '@/modules/collaboration/composition/decisionCommands'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDigitalEmployee,
  composeDigitalEmployeeTaskCatalogSource,
} from '@/modules/digital-employee/composition'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { createExecutionContractResourceAdapter } from '@/modules/resource-catalog/composition/executionContractResource'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { composeWebhookIngressPersistenceFor } from '@/modules/integration/composition/webhookIngress'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { createTaskStatusCounts } from '@/modules/task-execution/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/composition/taskCatalogSources'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { composeRepositoryMirrors } from '@/modules/source-control/composition'
import { mountClarifyRoutes } from '@/routes/clarify'
import { mountWellKnownRoutes } from '@/routes/docs'
import { mountHealthRoutes } from '@/routes/health'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { mountOverviewRoutes } from '@/routes/overview'
import { mountReviewRoutes } from '@/routes/reviews'
import { mountTaskCatalogRoutes } from '@/routes/taskCatalog'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { createHttpRequestApp, type AppHttpProviderCore } from '@/server'
import { createProductionOverviewQuery } from './productionOverview'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

export interface ProductionPerformanceApplicationInput {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly configPath: string
  readonly daemonToken: string
}

function unusedRuntimeCapability(): never {
  throw new Error('performance-http-read-invoked-unused-runtime-capability')
}

/** The caller owns this initialized root client, its app home and its lifetime. */
export async function createProductionPerformanceApplication(
  input: ProductionPerformanceApplicationInput,
): Promise<Hono> {
  const { db, appHome, configPath } = input
  const session = databaseSessionFor(db)
  const sourceWriteWindow = ALWAYS_WRITABLE_DATABASE_SOURCE
  const authRuntime = createAuthRuntimeFor({ db, sourceWriteWindow })
  const identityAccess = createIdentityAccessRuntime({ db })
  const core: AppHttpProviderCore = {
    provider: session.engine.provider,
    authRuntime,
    identityAccess,
    tokenCallAudit: createTokenCallAudit(db),
    sourceWriteWindow,
  }
  const repositoryStore = composeRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db))
  const overview = createProductionOverviewQuery(db, identityAccess)
  const executionContracts = composeExecutionContract({
    registrations: developmentExecutionContractRegistrations,
    resources: createExecutionContractResourceAdapter(db),
    programFixtures: createExecutionContractProgramFixtureAdapter({ appHome }),
  })
  const digitalEmployee = composeDigitalEmployee({
    db,
    appHome,
    typePackages: [developmentEmployeeTypePackage],
    executionContracts,
    runtime: {
      codecs: [developmentEmployeeRuntimeCodec],
      eventCenter: {
        observe: unusedRuntimeCapability,
        subscribe: unusedRuntimeCapability,
        unsubscribe: unusedRuntimeCapability,
        pendingDeliveries: unusedRuntimeCapability,
        acceptDelivery: unusedRuntimeCapability,
      },
      reactionExecution: {
        admission: unusedRuntimeCapability,
        port: () => ({
          launch: unusedRuntimeCapability,
          inspect: unusedRuntimeCapability,
          inspectHumanReview: unusedRuntimeCapability,
          cancel: unusedRuntimeCapability,
        }),
      },
      platformWorkItems: { execute: unusedRuntimeCapability },
    },
  })
  await digitalEmployee.maintenance.ready()
  const taskCatalog = composeTaskCatalog({
    sources: [
      ...composeTaskExecutionCatalogSources(db, composeOwnerIdentityQueries(db)),
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })
  const memoryOperations = composeMemoryOperationsFor({
    clarifyAnswers: createClarifyAnswerQueries(db),
    systemAgentBinding: memorySystemAgentBindingForTest(),
    db,
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(appHome, 'runs')),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(
      db,
      createFileReviewArtifactContent(appHome),
    ),
  })
  const collaborationContext = createCollaborationCommandContext(
    withO2Closure({
      db,
      appHome,
      taskExecutionReadModels: createTaskExecutionReadModels(db),
      reviewDecisions: createReviewDecisionCommand(withO2Closure({ db, appHome })),
      questionDispatches: createQuestionDispatchCommand(db, o2Ports(db).taskLock, {
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      }),
      clarifyDecisions: createClarifyDecisionCommand(
        db,
        memoryOperations.distillCommands,
        o2Ports(db).taskLock,
        { historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions },
      ),
    }),
  )
  const collaboration =
    session.engine.isolation === 'exclusive'
      ? composeCollaborationRouteOperations(withO2Closure({ db, context: collaborationContext }))
      : composeCollaborationRouteOperations(withO2Closure({ db, context: collaborationContext }))
  const workgroupTaskRoom = composeWorkgroupTaskRoom({
    db,
    taskParticipantFactory: composeWorkgroupTaskRoomTaskParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    activeUsers: composeWorkgroupTaskRoomActiveUsers({
      userDirectory: identityAccess.userDirectory,
    }),
    dynamicWorkflow: {
      validateGenerated: unusedRuntimeCapability,
      create: unusedRuntimeCapability,
    },
    continuation: {
      assertResumable: unusedRuntimeCapability,
      driveAfterCommit: unusedRuntimeCapability,
    },
    systemUserId: '__system__',
    broadcast: unusedRuntimeCapability,
  })
  const healthDatabase = createTaskStatusCounts(db)
  const webhookIngressPersistence = composeWebhookIngressPersistenceFor(db)
  return createHttpRequestApp({
    authentication: composeLocalHttpAuthentication({
      auth: core.authRuntime,
      daemonToken: input.daemonToken,
      identityAccess,
    }),
    core,
    publicRoutes: {
      health: (app) =>
        mountHealthRoutes(
          app,
          { opencodeVersion: '1.14.25', dbVersion: 17 },
          identityAccess.diagnostics,
          healthDatabase,
        ),
      wellKnown: (app) =>
        mountWellKnownRoutes(app, {
          configuration: composeFileApplicationConfigurationQueries(configPath),
        }),
      webhookIngress: (app) =>
        mountWebhookIngressRoutes(
          app,
          composeWebhookIngressTransport({ webhookIngressPersistence }),
        ),
    },
    deploymentMode: 'standalone',
    mountApi(app) {
      // This is the relative order in server.mountApiRoutes.
      mountOverviewRoutes(app, { directAuthority: identityAccess.directAuthority }, overview)
      mountCachedRepoRoutes(
        app,
        { configuration: composeFileApplicationConfigurationQueries(configPath), appHome },
        repositoryStore,
        composeRepositoryMirrors({ store: repositoryStore, appHome }),
      )
      mountWorkgroupTaskRoutes(app, {
        module: workgroupTaskRoom,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      })
      mountTaskCatalogRoutes(app, taskCatalog)
      mountReviewRoutes(app, collaboration, appHome)
      mountClarifyRoutes(app, collaboration)
    },
  })
}

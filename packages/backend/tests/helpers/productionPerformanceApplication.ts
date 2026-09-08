// RFC-359 AC11: the original HTTP transport around the real measured owner graph.
// Construction completes before callers time app.request and consume its response.
import type { Hono } from 'hono'

import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  composePostgresqlCollaborationRouteOperations,
  composeSqliteCollaborationRouteOperations,
} from '@/modules/collaboration/composition/collaborationRouteOperations'
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
import {
  composeExecutionContract,
  createPostgresqlExecutionContractResourceAdapter,
} from '@/modules/execution-contract/composition'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { composeWebhookIngressPersistenceFor } from '@/modules/integration/composition/webhookIngress'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { createHealthDatabaseReadModel } from '@/modules/system-operations/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/composition/taskCatalogSources'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
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

export interface ProductionPerformanceApplicationInput {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly configPath: string
  readonly daemonToken: string
}

function isPostgresql(db: ProviderNeutralDatabase): db is PostgresqlDatabaseClient {
  return '$provider' in db && db.$provider === 'postgresql'
}

function assertSqlite(db: ProviderNeutralDatabase): asserts db is DbClient {
  if ('$provider' in db) throw new Error('unsupported-performance-test-provider')
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
  const repositoryStore = composeRepositoryWorkspaceStore(db)
  const overview = createProductionOverviewQuery(db, identityAccess)
  const executionContractInput = {
    appHome,
    registrations: developmentExecutionContractRegistrations,
  }
  const executionContracts = isPostgresql(db)
    ? composeExecutionContract({
        ...executionContractInput,
        resources: createPostgresqlExecutionContractResourceAdapter(db),
      })
    : (() => {
        assertSqlite(db)
        return composeExecutionContract({ ...executionContractInput, db })
      })()
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
      execution: {
        launch: unusedRuntimeCapability,
        inspect: unusedRuntimeCapability,
        cancel: unusedRuntimeCapability,
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
    db,
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome),
  })
  const collaborationContext = createCollaborationCommandContext({
    db,
    appHome,
    taskExecutionReadModels: createTaskExecutionReadModels(db),
    reviewDecisions: createReviewDecisionCommand({ db, appHome }),
    questionDispatches: createQuestionDispatchCommand(db),
    clarifyDecisions: createClarifyDecisionCommand(db, memoryOperations.distillCommands),
  })
  const collaboration =
    session.engine.isolation === 'exclusive'
      ? composeSqliteCollaborationRouteOperations({ db, context: collaborationContext })
      : composePostgresqlCollaborationRouteOperations({ db, context: collaborationContext })
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
  const healthDatabase = createHealthDatabaseReadModel(db)
  const webhookIngressPersistence = composeWebhookIngressPersistenceFor(db)
  return createHttpRequestApp({
    token: input.daemonToken,
    core,
    publicRoutes: {
      health: (app) =>
        mountHealthRoutes(
          app,
          { opencodeVersion: '1.14.25', dbVersion: 17 },
          identityAccess.diagnostics,
          healthDatabase,
        ),
      wellKnown: (app) => mountWellKnownRoutes(app, { configPath }),
      webhookIngress: (app) => mountWebhookIngressRoutes(app, { webhookIngressPersistence }),
    },
    mountApi(app) {
      // This is the relative order in server.mountApiRoutes.
      mountOverviewRoutes(app, { directAuthority: identityAccess.directAuthority }, overview)
      mountCachedRepoRoutes(app, { configPath, appHome }, repositoryStore)
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

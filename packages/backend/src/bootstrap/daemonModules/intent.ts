// RFC-384: one Intent graph per session, with independent worker and HTTP families.
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeIntentApplyArtifactLifecycle,
  composeIntentApplyOperations,
  createIntentSessionWsPublisher,
  type IntentArtifactSelection,
} from '@/modules/intent/composition/apply'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import {
  resumeQueuedIntentWorkingSets,
  type IntentDispatchDeps,
} from '@/modules/intent/composition/dispatch'
import { composeIntentWorkflowGraphValidation } from '@/modules/intent/composition/graphValidation'
import { composeIntentMaintenanceSnapshotQueriesFor } from '@/modules/intent/composition/maintenance'
import { composeIntentPersistence } from '@/modules/intent/composition/persistence'
import { composeIntentContextResourceAuthorizationFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import { composeIntentQueuedResumption } from '@/modules/intent/composition/queuedResumption'
import { composeIntentResourceCatalogBinding } from '@/modules/intent/composition/resourceCatalog'
import type { IntentSessionRouteDependencies } from '@/modules/intent/composition/routes'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { directOperationAuthority } from '@/routes/operationAuthority'
import type { Logger } from '@/util/log'
import type { DaemonDigitalEmployeeModules } from './digitalEmployee'
import type { DaemonObservationModules } from './observation'
import type { DaemonProviderCore } from './providerCore'
import type { DaemonResourceCatalogModules } from './resourceCatalog'

export interface DaemonIntentInput {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly configuration: ApplicationConfigurationQueries
  readonly log: Pick<Logger, 'warn'>
  readonly core: Pick<DaemonProviderCore['identityAccess'], 'contexts' | 'directAuthority'>
  readonly resources: Pick<
    DaemonResourceCatalogModules,
    | 'resourceCatalog'
    | 'agentCatalog'
    | 'skillCatalog'
    | 'mcpCatalog'
    | 'pluginCatalog'
    | 'workflowCatalog'
    | 'workgroupCatalog'
    | 'capabilityTemplateOperations'
    | 'developmentConfigOperations'
  >
  readonly observation: Pick<
    DaemonObservationModules,
    'intentSystemAgentBinding' | 'intentHttpSystemAgentBinding'
  >
  readonly digitalEmployee: Pick<DaemonDigitalEmployeeModules, 'platformInventory'>
  readonly adapters?: {
    readonly intentArtifacts?: IntentArtifactSelection
    readonly httpTurnFixture?: Parameters<
      DaemonObservationModules['intentHttpSystemAgentBinding']['withFixture']
    >[0]
  }
}

export function composeDaemonIntentModules(input: DaemonIntentInput) {
  const { db, appHome, configuration, core, resources, observation } = input
  const authorityFor = (actor: Actor) => directOperationAuthority(core.directAuthority, actor)
  const resourceCatalogFor = composeIntentResourceCatalogBinding({
    resourceCatalog: resources.resourceCatalog,
    identityAccess: core,
    catalogs: {
      agents: resources.agentCatalog.queries,
      skills: resources.skillCatalog.queries,
      skillFiles: resources.skillCatalog.fileQueries,
      mcps: resources.mcpCatalog.queries,
      plugins: resources.pluginCatalog.queries,
      workflows: resources.workflowCatalog.queries,
      workgroups: resources.workgroupCatalog.queries,
    },
  })
  const persistence = composeIntentPersistence({
    db,
    contextAuthorization: composeIntentContextResourceAuthorizationFactory(),
  })
  const graphValidation = composeIntentWorkflowGraphValidation({
    validationQueries: resources.workflowCatalog.validationQueries,
    workflowQueries: resources.workflowCatalog.queries,
    authorityFor,
  })
  const artifacts = composeIntentApplyArtifactLifecycle({
    db,
    appHome,
    content: input.adapters?.intentArtifacts?.artifactContent,
  })
  const applyOperations = composeIntentApplyOperations({
    db,
    appHome,
    ...input.adapters?.intentArtifacts,
    aclIdentities: resources.resourceCatalog.persistence.identities,
    artifacts,
    graphValidation,
  })
  const platformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor,
    capabilityTemplates: resources.capabilityTemplateOperations,
    developmentConfig: resources.developmentConfigOperations,
    digitalEmployee: input.digitalEmployee.platformInventory,
  })
  const dumpAuxiliary = composeIntentDumpAuxiliaryQueries({
    persistence,
    configuration,
    platformInventory,
  })
  const events = createIntentSessionWsPublisher()
  const identityAccess = Object.freeze({ directAuthority: core.directAuthority })
  const dispatch: Omit<IntentDispatchDeps, 'configSnapshot'> = Object.freeze({
    persistence,
    events,
    identityAccess,
    appHome,
    runtimeResolver: composeIntentTurnRuntimeResolver(
      persistence,
      observation.intentSystemAgentBinding.bindRuntime,
    ),
    systemAgents: observation.intentSystemAgentBinding.family,
    dumpAuxiliary,
    graphValidation,
    resourceCatalogFor,
  })
  // A fixture replaces only the HTTP family; its paired resolver uses that same binding.
  const httpBinding =
    input.adapters?.httpTurnFixture === undefined
      ? observation.intentHttpSystemAgentBinding
      : observation.intentHttpSystemAgentBinding.withFixture(input.adapters.httpTurnFixture)
  const routes: IntentSessionRouteDependencies = Object.freeze({
    appHome,
    configuration,
    events,
    identityAccess,
    directAuthority: core.directAuthority,
    intentApply: applyOperations,
    intentPersistence: persistence,
    intentTurnRuntime: Object.freeze({
      runtimeResolver: composeIntentTurnRuntimeResolver(persistence, httpBinding.bindRuntime),
      systemAgents: httpBinding.family,
      dumpAuxiliary,
      graphValidation,
    }),
    resourceCatalogFor,
  })
  const maintenance = composeIntentMaintenanceSnapshotQueriesFor({ db, activity: applyOperations })
  const queuedResumption = composeIntentQueuedResumption({
    configuration,
    async resume(sessionIds, config) {
      await resumeQueuedIntentWorkingSets({ ...dispatch, configSnapshot: config }, sessionIds)
    },
    onError(error) {
      input.log.warn('queued intent working-set admission failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  return Object.freeze({
    persistence,
    resourceCatalogFor,
    graphValidation,
    dumpAuxiliary,
    events,
    applyOperations,
    dispatch,
    routes,
    maintenance,
    queuedResumption,
  })
}

export type DaemonIntentModules = ReturnType<typeof composeDaemonIntentModules>

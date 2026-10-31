import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
// RFC-380: construction is passive, session identities are shared, and a replacement gets its own graph.
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { composeDevelopmentPurposeRoot } from '@/bootstrap/developmentPurposeRoot'
import { createProviderHttpCompositionFixture } from './helpers/providerHttpComposition'
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeDaemonProviderCore } from '@/bootstrap/daemonModules/providerCore'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  standaloneModuleAdapters,
} from '@/bootstrap/daemonModules/adapters'
import { composeDaemonRepositoryCredentials } from '@/bootstrap/daemonModules/repositoryCredentials'
import {
  composeDaemonResourceCatalogModules,
  type DaemonResourceCatalogModules,
} from '@/bootstrap/daemonModules/resourceCatalog'
import { composeDaemonObservationModules } from '@/bootstrap/daemonModules/observation'
import { composeDaemonMemoryModules } from '@/bootstrap/daemonModules/memory'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { buildStartTaskDeps } from './helpers/startTaskDeps'
import { describeEachProvider, type ProviderApplicationBinding } from './helpers/eachProvider'

function graph(
  binding: ProviderApplicationBinding,
  appHome: string,
  diagnosticsCreated: () => void = () => {},
) {
  const db = binding.db
  const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 8))
  const adapters =
    binding.provider === 'sqlite'
      ? DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
          contract: logicalSchemaContract,
          db: binding.db,
          appHome,
          secretBox,
        })
      : DAEMON_PROVIDER_CORE_ADAPTERS.postgresql({
          contract: logicalSchemaContract,
          db: binding.db,
          runtime: binding.runtime,
          databaseConfig: binding.databaseConfig,
          appHome,
        })
  const core = composeDaemonProviderCore({
    sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
    db,
    appHome,
    secretBox,
    daemonToken: 'bundle-token',
    adapters,
    realtimePolicy: {
      resourceVisibility: { canViewResource: async () => false },
      memoryVisibility: { canViewMemory: async () => false },
      repoImportOwnerUserId: () => null,
      redactTaskEventPayload: (payload) => payload,
    },
    onCredentialRevoked() {},
    identityEvents: { authorityRevisionChanged() {} },
    presenceProjection: { publish() {} },
  })
  const configuration = composeApplicationConfigurationBinding({
    kind: 'file',
    configPath: join(appHome, 'config.json'),
  })
  const standalone = standaloneModuleAdapters()
  const observationModules = composeDaemonObservationModules({
    db,
    appHome,
    configuration: configuration.queries,
    notificationKey: configuration.notificationKey,
    identityAccess: core.identityAccess,
    daemonActor: core.daemonActor,
    runtimeRegistry: core.runtimeRegistry,
    mcpCatalog: () => resourceCatalogModules.mcpCatalog,
    adapters: {
      ...standalone,
      mcpDiagnostics(input) {
        diagnosticsCreated()
        return standalone.mcpDiagnostics(input)
      },
    },
  })
  const resourceCatalogModules: DaemonResourceCatalogModules = composeDaemonResourceCatalogModules({
    db,
    skillContentRoot: appHome,
    runtimeProfiles: { get: (name) => core.runtimeRegistry.getRuntime(name) },
    mcpRuntime: {
      prepareDelete: (id) => observationModules.mcpRuntimeTests.prepareMcpDelete(id),
      reconcileDurableIntents: () => observationModules.mcpRuntimeTests.reconcileDurableIntents(),
    },
  })
  const developmentPurposeRoot = composeDevelopmentPurposeRoot({ appHome })
  const repositoryCredentials = composeDaemonRepositoryCredentials({
    db,
    secretBox,
    appHome,
    developmentPurposeRoot,
    repositoryWorkspaceStore: core.repositoryWorkspaceStore,
    repositoryWorkspaceOperations: core.repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository: core.repositoryTransportCredentialRepository,
  })
  const memoryModules = composeDaemonMemoryModules({
    db,
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(appHome, 'runs')),
    systemAgentBinding: observationModules.memorySystemAgentBinding,
    contexts: core.identityAccess.contexts,
    reviewedArtifacts: { read: async () => '' },
  })
  return {
    core,
    observationModules,
    resourceCatalogModules,
    repositoryCredentials,
    memoryModules,
    secretBox,
    configuration,
    developmentPurposeRoot,
  }
}

describeEachProvider('RFC-380 passive module bundles', (harness) => {
  test('all five bundles are frozen, complete, passive and unique per replacement session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc380-bundles-'))
    const recording = harness.recordStatements()
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation((() => {
      throw new Error('composition-started-timeout')
    }) as unknown as typeof setTimeout)
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(() => {
      throw new Error('composition-started-interval')
    })
    let diagnostics = 0
    const sessions: ReturnType<typeof graph>[] = []
    try {
      sessions.push(graph(harness.applicationBinding, home, () => diagnostics++))
      sessions.push(graph(harness.applicationBinding, home, () => diagnostics++))
      expect(recording.statements).toHaveLength(0)
      expect(diagnostics).toBe(2)
      expect(sessions[0]!.observationModules.mcpRuntimeTests).not.toBe(
        sessions[1]!.observationModules.mcpRuntimeTests,
      )
      for (const session of sessions) {
        for (const name of [
          'core',
          'observationModules',
          'resourceCatalogModules',
          'repositoryCredentials',
          'memoryModules',
        ] as const) {
          expect(Object.isFrozen(session[name])).toBe(true)
          expect(Object.values(session[name]).every((value) => value !== undefined)).toBe(true)
          expect(session[name]).not.toBe(sessions[1 - sessions.indexOf(session)]![name])
        }
        expect(Object.keys(session.resourceCatalogModules).sort()).toEqual(
          [
            'resourceCatalog',
            'classicCatalogs',
            'agentResourceIntegrity',
            'skillCatalogBoot',
            'mcpProbeStore',
            'mcpTransactionLifecycle',
            'mcpCatalog',
            'agentCatalog',
            'skillCatalog',
            'pluginCatalog',
            'workflowCatalog',
            'workgroupCatalog',
            'capabilityTemplateOperations',
            'capabilityTemplateAcl',
            'developmentAdapterConfigOperations',
            'developmentConfigOperations',
            'developmentAdapterAcl',
            'digitalEmployeeAcl',
            'developmentAclRoutes',
            'digitalEmployeeAgentTemplates',
          ].sort(),
        )
        expect(Object.keys(session.repositoryCredentials).sort()).toEqual(
          [
            'repositoryWorkspaceStore',
            'repositoryWorkspaceOperations',
            'repositoryTransport',
            'codeHostConnections',
            'repositoryEndpointDiscovery',
            'repositoryPublicationTransport',
            'developmentDeliveryProvider',
            'developmentWorkspaceRepositoryPreparation',
          ].sort(),
        )
        // RFC-399 A10: the memory bundle also carries the task memory snapshot port.
        expect(Object.keys(session.memoryModules).sort()).toEqual(
          ['memoryOperations', 'memoryInjectionQueries', 'memoryCatalog', 'memorySnapshots'].sort(),
        )
        const observation = session.observationModules
        expect(Object.keys(observation).sort()).toEqual(
          [
            'observationCalls',
            'systemAgentObservations',
            'memorySystemAgentBinding',
            'intentSystemAgentBinding',
            'narrativeSystemAgentBinding',
            'intentHttpSystemAgentBinding',
            'workspacePresence',
            'runtimeSessionLeases',
            'mcpRuntimeTests',
            'runtimeManagement',
          ].sort(),
        )
        expect(
          new Set([
            observation.memorySystemAgentBinding,
            observation.intentSystemAgentBinding,
            observation.narrativeSystemAgentBinding,
            observation.intentHttpSystemAgentBinding,
          ]).size,
        ).toBe(4)
        expect(session.repositoryCredentials.repositoryWorkspaceStore).toBe(
          session.core.repositoryWorkspaceStore,
        )
        expect(session.memoryModules.memoryOperations.injectionQueries).toBe(
          session.memoryModules.memoryInjectionQueries,
        )
        expect(session.memoryModules.memoryOperations.catalog).toBe(
          session.memoryModules.memoryCatalog,
        )
      }
    } finally {
      timeout.mockRestore()
      interval.mockRestore()
      recording.stop()
      for (const session of sessions) {
        await session.observationModules.mcpRuntimeTests.dispose()
        session.core.identityAccess.shutdown()
      }
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// RFC-392: the same injection boundary serves both providers.
describeEachProvider('RFC-380 injected HTTP instances', (harness) => {
  test('HTTP uses the supplied authentication, catalog and diagnostics without reconstructing them', async () => {
    const binding = harness.applicationBinding
    const home = mkdtempSync(join(tmpdir(), 'rfc380-injection-'))
    let diagnostics = 0,
      reads = 0
    const session = graph(binding, home, () => diagnostics++)
    const catalogs = session.resourceCatalogModules
    const supplied = {
      ...catalogs,
      agentCatalog: {
        ...catalogs.agentCatalog,
        operations: {
          ...catalogs.agentCatalog.operations,
          list: {
            ...catalogs.agentCatalog.operations.list,
            invoke: (...args: Parameters<typeof catalogs.agentCatalog.operations.list.invoke>) => {
              reads++
              return catalogs.agentCatalog.operations.list.invoke(...args)
            },
          },
        },
      },
    }
    try {
      const opened = await createProviderHttpCompositionFixture(harness, {
        token: 'bundle-token',
        appHome: home,
        configPath: join(home, 'config.json'),
        dbVersion: 0,
        secretBox: session.secretBox,
        applicationConfiguration: session.configuration,
      })
      const http = opened.compose({
        core: session.core,
        observation: session.observationModules,
        resourceCatalog: supplied,
        repository: session.repositoryCredentials,
        memory: session.memoryModules,
      })
      const noTaskWork = (): never => {
        throw new Error('bundle identity test must not run tasks')
      }
      const startDeps = buildStartTaskDeps(
        binding.db,
        composeHumanGateOpenParticipantFactory(),
        {
          drive: noTaskWork,
          cancelChild: noTaskWork,
          resumeChild: noTaskWork,
          isTaskActive: noTaskWork,
        },
        join(home, 'config.json'),
        'bundle-user',
        session.secretBox,
        session.core.identityAccess,
        {
          repositoryWorkspace: session.core.repositoryWorkspaceStore,
          runtimeSessionLeases: session.observationModules.runtimeSessionLeases,
        },
      )
      expect(startDeps.repositoryWorkspace).toBe(session.core.repositoryWorkspaceStore)
      expect(startDeps.runtimeSessionLeases).toBe(session.observationModules.runtimeSessionLeases)
      expect(http.composition.authentication).toBe(session.core.httpAuthentication)
      expect(http.composition.core).toBe(session.core)
      expect(http.composition.core.tokenCallAudit).toBe(session.core.tokenCallAudit)
      expect(http.composition.resourceCatalog.repositories.store).toBe(
        session.core.repositoryWorkspaceStore,
      )
      try {
        const response = await http.app.request('/api/agents', {
          headers: { Authorization: 'Bearer bundle-token' },
        })
        expect(response.status).toBe(200)
        expect(reads).toBe(1)
        expect(diagnostics).toBe(1)
      } finally {
        await opened.dispose()
      }
    } finally {
      await session.observationModules.mcpRuntimeTests.dispose()
      session.core.identityAccess.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

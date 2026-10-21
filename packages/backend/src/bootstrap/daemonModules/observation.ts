import { type ProviderNeutralDatabase } from '@/db/query'
import { composeMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { type McpCatalogModule } from '@/modules/resource-catalog/public/operations'
import { composeRunObservationCalls } from '@/modules/run-observability/composition/runObservation'
import { composeRuntimeProbeConfigFence } from '@/modules/runtime-management/composition/runtimeManagement'
import { isRuntimeMcpTestEligible } from '@/modules/runtime-management/public/queries'
import { type ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { mcpOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { type DaemonModuleAdapters } from './adapters'
import { type DaemonProviderCore } from './providerCore'

export interface DaemonObservationInput {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly configuration: ApplicationConfigurationQueries
  readonly notificationKey: Parameters<typeof composeRuntimeProbeConfigFence>[0]
  readonly daemonActor: DaemonProviderCore['daemonActor']
  readonly identityAccess: DaemonProviderCore['identityAccess']
  readonly runtimeRegistry: DaemonProviderCore['runtimeRegistry']
  readonly mcpCatalog: () => McpCatalogModule
  readonly adapters: DaemonModuleAdapters
  readonly mcpRuntimeTestDependencies?: Partial<
    Pick<
      Parameters<DaemonModuleAdapters['mcpDiagnostics']>[0],
      'runFn' | 'now' | 'capacity' | 'appHome'
    >
  >
  readonly runtimeDiagnosticTestDependencies?: Parameters<
    DaemonModuleAdapters['runtimeManagement']
  >[0]['runtimeDiagnosticTestDependencies']
}

export function composeDaemonObservationModules(input: DaemonObservationInput) {
  const { identityAccess, runtimeRegistry } = input
  const observationCalls = composeRunObservationCalls(input.db)
  const systemAgentObservations = composeSystemAgentObservations({ calls: observationCalls })
  const family = () =>
    input.adapters.systemAgentRunFamily({
      appHome: () => input.appHome,
      observations: () => systemAgentObservations,
    })
  const memorySystemAgentBinding = family()
  const intentSystemAgentBinding = family()
  const narrativeSystemAgentBinding = family()
  const intentHttpSystemAgentBinding = family()
  const workspacePresence = input.adapters.workspacePresence()
  const runtimeSessionLeases = createRuntimeSessionLeaseOperations(input.db)
  const mcpRuntimeTests = input.adapters.mcpDiagnostics({
    observe:
      ({ session, turn, runtime, callId }) =>
      (startedAt) =>
        systemAgentObservations.open({
          ...(callId === undefined ? {} : { callId }),
          feature: 'mcp-runtime-test',
          agentName: 'aw-mcp-runtime-test',
          protocol: session.runtimeProtocol,
          startedAt,
          runtimeObservationIdentity: {
            registrationId: runtime.row.id,
            configurationRevision: runtime.row.probeFence,
            acceptedName: runtime.row.name,
          },
          ...(turn.seq > 1 && session.runtimeSessionId !== null
            ? { resumeSessionId: session.runtimeSessionId }
            : {}),
          demand: {
            kind: 'mcp-runtime-test',
            originalId: session.id,
            originalAttempt: turn.id,
            name: 'MCP 测试 · ' + session.runtimeName,
            ownerUserId: session.ownerUserId,
            purpose: 'playground',
          },
        }),
    ...composeMcpRuntimeTestProvider(input.db),
    isRuntimeEligible: isRuntimeMcpTestEligible,
    coordinator: mcpOperationCoordinator,
    requestBinding: {
      contexts: identityAccess.contexts,
      directAuthority: identityAccess.directAuthority,
      loadVisibleMcp: (authority, id) => input.mcpCatalog().queries.get(authority, { id }),
    },
    async loadMcp(mcpId) {
      const actor = await input.daemonActor('mcp-runtime-test-authority-not-admitted')
      return input
        .mcpCatalog()
        .queries.get(directOperationAuthority(identityAccess.directAuthority, actor), {
          id: mcpId,
        })
    },
    loadRuntime: (name) => runtimeRegistry.getRuntime(name),
    configuration: input.configuration,
    ...input.mcpRuntimeTestDependencies,
    appHome: input.mcpRuntimeTestDependencies?.appHome ?? input.appHome,
  })
  const runtimeManagement = input.adapters.runtimeManagement({
    observations: () => systemAgentObservations,
    configuration: {
      current: () => input.configuration.read(),
      withProbeReceiptFence: composeRuntimeProbeConfigFence(input.notificationKey),
    },
    runtimeRegistry,
    runtimeTests: mcpRuntimeTests.reconciliation,
    ...(input.runtimeDiagnosticTestDependencies === undefined
      ? {}
      : { runtimeDiagnosticTestDependencies: input.runtimeDiagnosticTestDependencies }),
    appHome: () => input.appHome,
  })
  return Object.freeze({
    observationCalls,
    systemAgentObservations,
    memorySystemAgentBinding,
    intentSystemAgentBinding,
    narrativeSystemAgentBinding,
    intentHttpSystemAgentBinding,
    workspacePresence,
    runtimeSessionLeases,
    mcpRuntimeTests,
    runtimeManagement,
  })
}
export type DaemonObservationModules = ReturnType<typeof composeDaemonObservationModules>

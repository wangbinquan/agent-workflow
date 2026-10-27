// RFC-380 / RFC-381 / RFC-382 / RFC-383 / RFC-384 / RFC-376 hard gate: bundles are session-scoped, and the application graph constructs each bundle once.
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

// Slowest case took 3.40 s on CI run 40433510287 including hooks (2.08 s before RFC-395 II-b); allow 20 s.
setDefaultTimeout(20_000)

const PREFIX = 'packages/backend/src/'
const BUNDLES = [
  'composeDaemonProviderCore',
  'composeDaemonRepositoryCredentials',
  'composeDaemonResourceCatalogModules',
  'composeDaemonObservationModules',
  'composeDaemonMemoryModules',
  'composeDaemonScheduledTaskModules',
  'composeDaemonIntegrationModules',
  'composeDaemonFusionModules',
  'composeDaemonTaskExecutionModules',
  'composeDaemonDigitalEmployeeModules',
  'composeDaemonDevelopmentAutomationModules',
  'composeDaemonIntentModules',
] as const
const ROOTS = [['bootstrap/daemonApplication.ts', 'composeDaemonApplication']] as const
const FACTORIES = new Set([
  'composeIntentResourceCatalogFor',
  'composeIntentResourceCatalogBinding',
  'composeIntentPersistence',
  'composeIntentContextResourceAuthorizationFactory',
  'composeIntentWorkflowGraphValidation',
  'composeIntentApplyArtifactLifecycle',
  'composeIntentApplyOperations',
  'composeIntentPlatformInventoryParticipant',
  'composeIntentDumpAuxiliaryQueries',
  'composeIntentTurnRuntimeResolver',
  'createIntentSessionWsPublisher',
  'composeIntentMaintenanceSnapshotQueriesFor',
  'composeIntentQueuedResumption',
  'resumeQueuedIntentWorkingSets',
  'composeDigitalEmployee',
  'composeDevelopmentAutomation',
  'composeReactionExecutionProvider',
  'composeDevelopmentMissionOperations',
  'composeMissionInputUploadOperations',
  'composeDigitalEmployeeWriterCutoverFor',
  'composeDevelopmentEmployeeWorkspace',
  'composeDevelopmentEmployeePlatformWorkItems',
  'createEmployeeReactionRoundQueries',
  'createEmployeeInputArtifactStore',
  'composeDigitalEmployeeBuiltinToolCatalog',
  'composeDigitalEmployeePlatformInventoryParticipant',
  'composeDevelopmentActivityOperations',
  'composeDigitalEmployeeTaskCatalogSource',
  'composeDigitalEmployeeRoutePersistence',
  'composeDevelopmentAdmissionLookup',
  'createDevelopmentMissionExecutionTerminalObserver',
  'composeAgentActionExecution',
  'composeScriptActionExecution',

  'createTaskDriveCoordinator',
  'DefaultTaskDriveCoordinator',
  'createTaskDriveCoordinatorFactory',
  'composeTaskExecutionProviderRuntime',
  'composeProcessTaskExecutionBinding',
  'composeSessionTaskExecutionBinding',
  'createTaskRouteOperations',
  'createTaskExecutionPersistence',
  'createTaskExecutionResourceBinding',
  'composeTaskExecutionResourceBinding',
  'createTaskExecutionRuntimeParticipants',
  'composeTaskExecutionRuntime',
  'createTaskDriverLifecyclePort',
  'createDatabaseTaskDriverLifecyclePort',
  'createTaskExecutionLaunchParticipant',
  'createTaskRouteLaunchOperations',
  'createBuildScheduleLaunch',
  'createTaskExecutionTriggerParticipant',
  'createTaskOverviewQuery',
  'createDatabaseTaskLifecycleWsProjector',
  'createSqliteTaskLifecycleWsProjector',
  'composeTaskClarifyDirectiveRouteOperations',
  'composeWorkgroupTaskRoomTaskParticipantFactory',
  'composeTaskExecutionCatalogSources',
  'createDatabaseTaskExecutionCatalogSourceFactory',
  'composeHostTaskLaunchKernel',
  'composeRepositoryWorkspaceStore',
  'composeSqliteRepositoryWorkspaceStore',
  'composePostgresqlRepositoryWorkspaceStore',
  'composeRepositoryWorkspaceOperations',
  'DrizzleRepositoryTransportCredentialRepository',
  'SQLiteRepositoryTransportCredentialRepository',
  'PostgresqlRepositoryTransportCredentialRepository',
  'createAuthRuntimeFor',
  'createTokenCallAudit',
  'createIdentityAccessRuntime',
  'createTaskStatusCounts',
  'composeRuntimeProfileParticipants',
  'composeRuntimeRegistryOperations',
  'composeRealtimeRuntimeFor',
  'composeSystemOperations',
  'composePostgresqlSystemOperations',
  'composeSqliteMaintenanceDiskOperations',
  'composePostgresqlMaintenanceDiskOperations',
  'composeRepositoryTransportCredentials',
  'createCodeHostConnectionsService',
  'createRepositoryEndpointDiscovery',
  'createRepositoryPublicationTransport',
  'createDevelopmentDeliveryProvider',
  'composeSelectedPipelineEvidenceRunnerFor',
  'createDevelopmentWorkspaceRepositoryPreparation',
  'composeResourceCatalogFor',
  'composeClassicCatalogs',
  'composeDatabaseAgentResourceIntegrity',
  'composeSkillCatalogBoot',
  'createAsyncSkillRestoreMembership',
  'composeMcpProbeStore',
  'composeMcpCatalog',
  'createMcpTransactionLifecycle',
  'mcpAclRuntimeTestLifecycle',
  'composeMcpRuntimeTestProvider',
  'composePluginCatalog',
  'composeWorkgroupCatalog',
  'composeCapabilityTemplateOperations',
  'createCapabilityTemplatePersistence',
  'createDigitalEmployeeResourceCatalogAclProviders',
  'composeDevelopmentAdapterConfigOperationsFor',
  'composeDevelopmentConfigOperations',
  'composeDevelopmentConfigOperationsFor',
  'composeForeignResourceAclFor',
  'composeDigitalEmployeeAgentTemplateCatalogFor',
  'composeRunObservationCalls',
  'composeSystemAgentObservations',
  'composeLocalSystemAgentRunFamily',
  'composeLocalMcpDiagnostics',
  'composeLocalRuntimeManagement',
  'createFileWorkspacePresenceQueries',
  'createRuntimeSessionLeaseOperations',
  'composeMemoryOperationsFor',
  'composeSqliteMemoryOperations',
  'composePostgresqlMemoryOperations',
  'composeMemoryInjectionQueriesFor',
  'composeSqliteMemoryInjectionQueries',
  'composePostgresqlMemoryInjectionQueries',
  'composeMemoryCatalogOperations',
  'composeScheduledTaskRuntimeFor',
  'composeIntegrationTriggerResourceSnapshotFactory',
  'composeTaskSourceTermination',
  'composeMrTerminalControl',
  'composeWebhookDispatchCore',
  'composeWebhookDispatchPersistenceFor',
  'composeWebhookDeliveryPersistenceFor',
  'createWebhookDispatcher',
  'createWebhookRepositoryResolver',
  'composeWebhookLaunchAdmission',
  'createWebhookDispatchExecutionRuntime',
  'composeWebhookEndpointServiceDependencies',
  'composeWebhookTriggerServiceDependenciesFor',
  'composeWebhookTriggerValidation',
  'composeWebhookDeliveryRuntimeFor',
  'composeWebhookIngressPersistenceFor',
  'createEventAutomationWorkIntentStore',
  'createEventAutomationDelegatedContextBinding',
  'createTaskAutomationWorkStartProvider',
  'createEmployeeAutomationWorkStartProvider',
  'composeEventCenter',
  'composeSelectedApprovalGatewayRunnerFor',
  'composeDevelopmentToolConnectionCatalog',
  'composeFusionOperationsFor',
  'composeSkillMemoryFusionParticipantFactory',
  'composeSkillVersionCommitParticipantFactory',
])
const RETIRED = [
  'composeIntentQueuedNotifications',
  'createQueuedIntentNotifications',
  'composeFallbackDevelopmentAutomation',
  'composeSqliteDaemonProviderCore',
  'composePostgresqlDaemonProviderCore',
  'createPostgresqlAuthRuntime',
  'composeSqliteUncredentialedDevelopmentDeliveryProvider',
]
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function expressionNames(node: ts.Expression): string[] {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return expressionNames(node.expression)
  if (ts.isBinaryExpression(node))
    return [...expressionNames(node.left), ...expressionNames(node.right)]
  if (ts.isConditionalExpression(node))
    return [...expressionNames(node.whenTrue), ...expressionNames(node.whenFalse)]
  return []
}
function callNames(node: ts.Node): string[] {
  return ts.isCallExpression(node) || ts.isNewExpression(node)
    ? expressionNames(node.expression)
    : []
}
function valueImport(node: ts.ImportDeclaration): boolean {
  if (!node.importClause) return true
  if (node.importClause.isTypeOnly) return false
  const bindings = node.importClause.namedBindings
  return (
    node.importClause.name !== undefined ||
    bindings === undefined ||
    ts.isNamespaceImport(bindings) ||
    bindings.elements.some((element) => !element.isTypeOnly)
  )
}

export function daemonBundleViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  for (const [path, name] of ROOTS) {
    const unit = units.find((unit) => unit.path === PREFIX + path)
    const root = unit?.source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    for (const bundle of BUNDLES) {
      let count = 0
      if (root)
        walk(root, (node) => {
          if (callNames(node).includes(bundle)) count++
        })
      if (count !== 1) errors.push(`${path}: ${name} must call ${bundle} once; got ${count}`)
    }
    if (!unit) {
      errors.push(`${path}: required bundle root missing`)
      continue
    }
    walk(unit.source, (node) => {
      const names = callNames(node)
      for (const factory of names)
        if (FACTORIES.has(factory)) errors.push(`${path}: direct factory ${factory}`)
      const called = names.find((name) => BUNDLES.includes(name as (typeof BUNDLES)[number]))
      if (!called || !BUNDLES.includes(called as (typeof BUNDLES)[number])) return
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor && ancestor !== root) ancestor = ancestor.parent
      if (!ancestor) errors.push(`${path}: bundle outside provider session ${called}`)
    })
  }
  for (const unit of units) {
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && RETIRED.includes(node.name?.text ?? ''))
        errors.push(`${unit.path}: retired constructor ${node.name!.text}`)
    })
    if (!unit.path.startsWith(PREFIX + 'bootstrap/daemonModules/')) continue
    if (/\/(?:sqlite|postgresql)/i.test(unit.path))
      errors.push(`${unit.path}: provider-named bundle`)
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && /Sqlite|Postgresql/.test(node.name?.text ?? ''))
        errors.push(`${unit.path}: provider-named function`)
      if (
        unit.path !== PREFIX + 'bootstrap/daemonModules/providerCore.ts' &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith('@/modules/identity-access/')
      )
        errors.push(`${unit.path}: identity-access import outside provider core`)
      if (
        ts.isImportDeclaration(node) &&
        valueImport(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:^|\/)(?:server|daemonStart|daemonApplication|daemonSession|daemonSessionAdapters)(?:\.ts)?$/.test(
          node.moduleSpecifier.text,
        )
      )
        errors.push(`${unit.path}: entry root value import`)
    })
  }
  return errors
}
const unit = (path: string, text: string) => sourceUnit(PREFIX + path, text)
function valid() {
  return ROOTS.map(([path, name]) =>
    unit(
      path,
      `function ${name}() { ${BUNDLES.map((b, i) => `const x${i} = ${b}({});`).join(' ')} }`,
    ),
  )
}
describe('RFC-380 daemon module bundles', () => {
  test('complete source corpus keeps the twelve application-session bundles', () => {
    const units = backendUnits(resolve(import.meta.dir, '../../../..'))
    expect(units.length).toBeGreaterThanOrEqual(2000)
    expect(
      units.filter((u) => u.path.startsWith(PREFIX + 'bootstrap/daemonModules/')),
    ).toHaveLength(13)
    expect(daemonBundleViolations(units)).toEqual([])
  })
  test('accepts one bundle per session', () => {
    expect(daemonBundleViolations(valid())).toEqual([])
  })
  test('rejects missing and duplicated session calls', () => {
    expect(daemonBundleViolations([])).toEqual([
      ...BUNDLES.map(
        (bundle) =>
          `bootstrap/daemonApplication.ts: composeDaemonApplication must call ${bundle} once; got 0`,
      ),
      'bootstrap/daemonApplication.ts: required bundle root missing',
    ])
    const units = valid()
    units[0] = unit(
      ROOTS[0][0],
      `function composeDaemonApplication() { ${BUNDLES.map((b) => `${b}({}); ${b}({});`).join(' ')} }`,
    )
    expect(daemonBundleViolations(units).filter((e) => e.includes('got 2'))).toHaveLength(12)
  })
  test('rejects process-level construction', () => {
    const units = valid()
    units[0] = unit(ROOTS[0][0], units[0]!.source.text + 'composeDaemonMemoryModules({});')
    expect(daemonBundleViolations(units)).toEqual(
      expect.arrayContaining([expect.stringContaining('outside provider session')]),
    )
  })
  test('rejects every member factory left in a root, including constructors', () => {
    for (const factory of FACTORIES) {
      const units = valid()
      for (const call of [`new ${factory}({});`, `(selection ?? ${factory})({});`]) {
        units[0] = unit(ROOTS[0][0], valid()[0]!.source.text + call)
        expect(daemonBundleViolations(units)).toContain(
          `bootstrap/daemonApplication.ts: direct factory ${factory}`,
        )
      }
    }
  })
  test('rejects retired constructors, provider names and entry-root imports', () => {
    for (const name of RETIRED)
      expect(
        daemonBundleViolations([...valid(), unit('old.ts', `function ${name}() {}`)]),
      ).toContain(`packages/backend/src/old.ts: retired constructor ${name}`)
    const bad = unit(
      'bootstrap/daemonModules/sqliteBad.ts',
      "import { x } from '@/server'; function composeSqliteBad() {}",
    )
    expect(daemonBundleViolations([...valid(), bad])).toHaveLength(3)
    const startup = unit(
      'bootstrap/daemonModules/startup.ts',
      "import { startCommand } from '@/bootstrap/daemonStart'",
    )
    expect(daemonBundleViolations([...valid(), startup])).toEqual([
      'packages/backend/src/bootstrap/daemonModules/startup.ts: entry root value import',
    ])
    const good = unit(
      'bootstrap/daemonModules/good.ts',
      "import type { X } from '@/server'; import { type Y } from '@/bootstrap/daemonStart'; function composeGood() {}",
    )
    expect(daemonBundleViolations([...valid(), good])).toEqual([])
    const identity = unit(
      'bootstrap/daemonModules/integration.ts',
      "import { binding } from '@/modules/identity-access/composition';",
    )
    expect(daemonBundleViolations([...valid(), identity])).toEqual([
      'packages/backend/src/bootstrap/daemonModules/integration.ts: identity-access import outside provider core',
    ])
  })
})

// RFC-395 U4 retires legacy boot upgrades. The retained skill-operation recovery is provider-neutral.
function operationRecoveryRestrictions(source: SourceUnit): number {
  let restrictions = 0
  walk(source.source, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return
    const id = node.properties.find(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(source.source) === 'id',
    )
    if (
      !id ||
      !ts.isPropertyAssignment(id) ||
      !ts.isStringLiteral(id.initializer) ||
      id.initializer.text !== 'skill-operation-recovery'
    )
      return
    restrictions += node.properties.filter(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(source.source) === 'providers',
    ).length
  })
  return restrictions
}
test('both providers register operation recovery; retired boot upgrades stay absent', () => {
  const lifecycle = backendUnits(resolve(import.meta.dir, '../../../..')).find(
    (u) => u.path === PREFIX + 'bootstrap/daemonLifecycleProgram.ts',
  )!
  expect(lifecycle).toBeDefined()
  expect(lifecycle.text).toContain("id: 'skill-operation-recovery'")
  expect(lifecycle.text).not.toContain("id: 'legacy-mission-recovery'")
  expect(operationRecoveryRestrictions(lifecycle)).toBe(0)
  expect(
    operationRecoveryRestrictions(
      unit(
        'bootstrap/daemonLifecycleProgram.ts',
        "const steps = [{ id: 'skill-operation-recovery', providers: ['sqlite'] }]",
      ),
    ),
  ).toBe(1)
})

// RFC-391: the application is built before maintenance, which reads that same intent bundle.
function intentMaintenanceOrderViolations(source: SourceUnit): string[] {
  const root = source.source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'composeDaemonSession',
  )
  let application: ts.VariableDeclaration | undefined
  let intent: ts.VariableDeclaration | undefined
  const maintenance: ts.CallExpression[] = []
  if (root)
    walk(root, (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source.source) === 'application')
        application = node
      if (ts.isVariableDeclaration(node) && node.name.getText(source.source) === 'intentModules')
        intent = node
      if (ts.isCallExpression(node) && callNames(node).includes('createMaintenanceService'))
        maintenance.push(node)
    })
  const errors: string[] = []
  if (
    !application ||
    !intent ||
    maintenance.length !== 1 ||
    application.pos >= intent.pos ||
    intent.pos >= maintenance[0]!.pos
  )
    errors.push('application and intent bundle must precede maintenance')
  if (
    !application?.initializer?.getText(source.source).includes('composeDaemonApplication(') ||
    intent?.initializer?.getText(source.source) !== 'runtime.intentModules'
  )
    errors.push('maintenance must use the session application intent bundle')
  return errors
}
test('application and intent precede maintenance; inversions and missing reads fail', () => {
  const session = backendUnits(resolve(import.meta.dir, '../../../..')).find(
    (u) => u.path === PREFIX + 'bootstrap/daemonSession.ts',
  )!
  expect(intentMaintenanceOrderViolations(session)).toEqual([])
  const fixture = (reverse: boolean) =>
    unit(
      'bootstrap/daemonSession.ts',
      `function composeDaemonSession() { const application = composeDaemonApplication({}); ${reverse ? 'createMaintenanceService({});' : ''} const intentModules = runtime.intentModules; ${reverse ? '' : 'createMaintenanceService({});'} }`,
    )
  expect(intentMaintenanceOrderViolations(fixture(false))).toEqual([])
  expect(intentMaintenanceOrderViolations(fixture(true))).toHaveLength(1)
  expect(intentMaintenanceOrderViolations(unit('bootstrap/daemonSession.ts', ''))).toHaveLength(2)
})
test('the session intent bundle cannot move outside the application graph', () => {
  const units = valid()
  units[0] = unit(
    ROOTS[0][0],
    units[0]!.text + 'function mountRoutes() { composeDaemonIntentModules({}); }',
  )
  expect(daemonBundleViolations(units)).toContain(
    'bootstrap/daemonApplication.ts: bundle outside provider session composeDaemonIntentModules',
  )
})

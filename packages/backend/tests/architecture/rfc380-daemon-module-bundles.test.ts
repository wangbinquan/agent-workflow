// RFC-380 / RFC-381 / RFC-382 / RFC-383 / RFC-384 / RFC-376 hard gate: bundles are session-scoped, and HTTP only composes fallbacks.
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

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
const ROOTS = [
  ['cli/start.ts', 'composeSqliteProviderSession'],
  ['cli/postgresqlDaemonApplication.ts', 'composePostgresqlApplication'],
  ['server.ts', 'composeSqliteApplicationDeps'],
] as const
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
  'composeSqliteTaskExecutionProviderRuntime',
  'composePostgresqlTaskExecutionProviderRuntime',
  'createTaskRouteOperations',
  'createTaskExecutionPersistence',
  'createTaskExecutionResourceBinding',
  'composeTaskExecutionResourceBinding',
  'createTaskExecutionRuntimeParticipants',
  'composeTaskExecutionRuntime',
  'createTaskDriverLifecyclePort',
  'createDatabaseTaskDriverLifecyclePort',
  'createSqliteTaskExecutionLaunchParticipant',
  'createSqliteTaskRouteLaunchOperations',
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
  'createHealthDatabaseReadModel',
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
    if (!unit) continue
    walk(unit.source, (node) => {
      const names = callNames(node)
      for (const factory of names)
        if (FACTORIES.has(factory)) errors.push(`${path}: direct factory ${factory}`)
      const called = names.find((name) => BUNDLES.includes(name as (typeof BUNDLES)[number]))
      if (!called || !BUNDLES.includes(called as (typeof BUNDLES)[number])) return
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor && ancestor !== root) ancestor = ancestor.parent
      if (!ancestor) errors.push(`${path}: bundle outside provider session ${called}`)
      if (
        path === 'server.ts' &&
        !(
          ts.isBinaryExpression(node.parent) &&
          node.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          node.parent.right === node
        )
      )
        errors.push(`${path}: bundle is not a nullish fallback ${called}`)
    })
  }
  for (const unit of units) {
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && RETIRED.includes(node.name?.text ?? ''))
        errors.push(`${unit.path}: retired constructor ${node.name!.text}`)
    })
    if (!unit.path.startsWith(PREFIX + 'cli/daemonModules/')) continue
    if (/\/(?:sqlite|postgresql)/i.test(unit.path))
      errors.push(`${unit.path}: provider-named bundle`)
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && /Sqlite|Postgresql/.test(node.name?.text ?? ''))
        errors.push(`${unit.path}: provider-named function`)
      if (
        unit.path !== PREFIX + 'cli/daemonModules/providerCore.ts' &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith('@/modules/identity-access/')
      )
        errors.push(`${unit.path}: identity-access import outside provider core`)
      if (
        ts.isImportDeclaration(node) &&
        valueImport(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:^|\/)(?:server|start|postgresqlDaemonApplication)(?:\.ts)?$/.test(
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
      `function ${name}() { ${BUNDLES.map((b, i) => `const x${i} = ${path === 'server.ts' ? 'deps.x ?? ' : ''}${b}({});`).join(' ')} }`,
    ),
  )
}
describe('RFC-380 daemon module bundles', () => {
  test('complete source corpus keeps the twelve session bundles and the HTTP fallbacks', () => {
    const units = backendUnits(resolve(import.meta.dir, '../../../..'))
    expect(units.length).toBeGreaterThanOrEqual(2000)
    expect(units.filter((u) => u.path.startsWith(PREFIX + 'cli/daemonModules/'))).toHaveLength(13)
    expect(daemonBundleViolations(units)).toEqual([])
  })
  test('accepts one bundle per session and nullish HTTP fallbacks', () => {
    expect(daemonBundleViolations(valid())).toEqual([])
  })
  test('rejects missing and duplicated session calls', () => {
    expect(daemonBundleViolations([])).toHaveLength(36)
    const units = valid()
    units[0] = unit(
      ROOTS[0][0],
      `function composeSqliteProviderSession() { ${BUNDLES.map((b) => `${b}({}); ${b}({});`).join(' ')} }`,
    )
    expect(daemonBundleViolations(units).filter((e) => e.includes('got 2'))).toHaveLength(12)
  })
  test('rejects process-level construction and unconditional HTTP construction', () => {
    const units = valid()
    units[0] = unit(ROOTS[0][0], units[0]!.source.text + 'composeDaemonMemoryModules({});')
    units[2] = unit(ROOTS[2][0], units[2]!.source.text.replace('deps.x ?? ', ''))
    expect(daemonBundleViolations(units)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('outside provider session'),
        expect.stringContaining('not a nullish fallback'),
      ]),
    )
  })
  test('rejects every member factory left in a root, including constructors', () => {
    for (const factory of FACTORIES) {
      const units = valid()
      for (const call of [`new ${factory}({});`, `(selection ?? ${factory})({});`]) {
        units[0] = unit(ROOTS[0][0], valid()[0]!.source.text + call)
        expect(daemonBundleViolations(units)).toContain(`cli/start.ts: direct factory ${factory}`)
      }
    }
  })
  test('rejects retired constructors, provider names and entry-root imports', () => {
    for (const name of RETIRED)
      expect(
        daemonBundleViolations([...valid(), unit('old.ts', `function ${name}() {}`)]),
      ).toContain(`packages/backend/src/old.ts: retired constructor ${name}`)
    const bad = unit(
      'cli/daemonModules/sqliteBad.ts',
      "import { x } from '@/server'; function composeSqliteBad() {}",
    )
    expect(daemonBundleViolations([...valid(), bad])).toHaveLength(3)
    const good = unit(
      'cli/daemonModules/good.ts',
      "import type { X } from '@/server'; import { type Y } from '@/cli/start'; function composeGood() {}",
    )
    expect(daemonBundleViolations([...valid(), good])).toEqual([])
    const identity = unit(
      'cli/daemonModules/integration.ts',
      "import { binding } from '@/modules/identity-access/composition';",
    )
    expect(daemonBundleViolations([...valid(), identity])).toEqual([
      'packages/backend/src/cli/daemonModules/integration.ts: identity-access import outside provider core',
    ])
  })
})

// RFC-383: legacy recovery is provider-neutral, unlike the retained PG identity boot check.
function legacyRecoveryRestrictions(source: SourceUnit): number {
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
      id.initializer.text !== 'legacy-mission-recovery'
    )
      return
    restrictions += node.properties.filter(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(source.source) === 'providers',
    ).length
  })
  return restrictions
}
test('both providers register legacy recovery; provider restrictions are rejected', () => {
  const lifecycle = backendUnits(resolve(import.meta.dir, '../../../..')).find(
    (u) => u.path === PREFIX + 'cli/daemonLifecycleProgram.ts',
  )!
  expect(lifecycle).toBeDefined()
  expect(lifecycle.text).toContain("id: 'legacy-mission-recovery'")
  expect(legacyRecoveryRestrictions(lifecycle)).toBe(0)
  expect(
    legacyRecoveryRestrictions(
      unit(
        'cli/daemonLifecycleProgram.ts',
        "const steps = [{ id: 'legacy-mission-recovery', providers: ['sqlite'] }]",
      ),
    ),
  ).toBe(1)
})

// RFC-384: construction precedes maintenance in both session roots, including PG's runtime read.
function intentMaintenanceOrderViolations(source: SourceUnit): string[] {
  const errors: string[] = []
  for (const name of ['composeSqliteProviderSession', 'composePostgresqlProviderSession']) {
    const root = source.source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    let intent: ts.VariableDeclaration | undefined
    const maintenance: ts.CallExpression[] = []
    if (root)
      walk(root, (node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source.source) === 'intentModules')
          intent = node
        if (ts.isCallExpression(node) && callNames(node).includes('createMaintenanceService'))
          maintenance.push(node)
      })
    if (!intent || maintenance.length !== 1 || intent.pos >= maintenance[0]!.pos)
      errors.push(`${name}: intent bundle must precede maintenance`)
    const expected =
      name === 'composeSqliteProviderSession'
        ? 'composeDaemonIntentModules({'
        : 'runtime.intentModules'
    if (!intent?.initializer?.getText(source.source).replace(/\s/g, '').includes(expected))
      errors.push(`${name}: maintenance must use the session intent bundle`)
  }
  return errors
}
test('intent bundles exist before both maintenance services; inversions and missing reads fail', () => {
  const start = backendUnits(resolve(import.meta.dir, '../../../..')).find(
    (u) => u.path === PREFIX + 'cli/start.ts',
  )!
  expect(intentMaintenanceOrderViolations(start)).toEqual([])
  const roots = (reverse: boolean) =>
    unit(
      'cli/start.ts',
      [
        ['composeSqliteProviderSession', 'composeDaemonIntentModules({})'],
        ['composePostgresqlProviderSession', 'runtime.intentModules'],
      ]
        .map(
          ([name, value]) =>
            `function ${name}() { ${reverse ? 'createMaintenanceService({});' : ''} const intentModules = ${value}; ${reverse ? '' : 'createMaintenanceService({});'} }`,
        )
        .join('\n'),
    )
  expect(intentMaintenanceOrderViolations(roots(false))).toEqual([])
  expect(intentMaintenanceOrderViolations(roots(true))).toHaveLength(2)
  expect(intentMaintenanceOrderViolations(unit('cli/start.ts', ''))).toHaveLength(4)
})
test('HTTP intent fallback cannot move to route mounting', () => {
  const units = valid()
  units[2] = unit(
    'server.ts',
    units[2]!.text.replace('deps.x ?? composeDaemonIntentModules({});', 'null;') +
      'function composeSqliteApiRouteMounts() { const x = deps.intentModules ?? composeDaemonIntentModules({}); }',
  )
  expect(daemonBundleViolations(units)).toContain(
    'server.ts: bundle outside provider session composeDaemonIntentModules',
  )
})

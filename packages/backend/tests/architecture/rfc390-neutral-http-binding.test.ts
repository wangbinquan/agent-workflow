// RFC-390 / RFC-376: one passive HTTP owner graph and one route table for every provider.
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const ROOTS = [['bootstrap/daemonApplication.ts', 'composeDaemonApplication']] as const
const RETIRED = [
  'composeSqliteApiRouteMounts',
  'SqliteApiRouteComposition',
  'ResourcePackageRouteBinding',
  'RuntimeComposedAppDeps',
  'SqliteComposedAppDeps',
  'SqliteAppDeps',
  'composeLegacyConfigConcurrencyHotApply',
  'composePostgresqlAppDeps',
  'NO_RESOURCE_PACKAGE_APPLY_ACTIVITY',
]
const HTTP_OWNERS = [
  'composeOidcIdentityOperations',
  'createOidcProvidersService',
  'composeIdentityUserOperations',
  'composeCodeHistoryQueries',
  'composeLegacyCodeReadProviders',
  'createTaskCodeWorkspaceQueries',
  'composeClarifyFollowupGenerator',
  'composeTaskRuntimeInventoryContent',
  'composeRuntimeProbeConfigFence',
  'createTaskObservationFacts',
  'composeWebhookIngressTransport',
  'createPostgresqlCapabilityTemplatePackageMutationOwner',
  'createPostgresqlResourcePackageExecutionAdapter',
  'createResourcePackagePluginInstaller',
  'composeWorkgroupTaskRoomActiveUsers',
  'composeWorkgroupTaskRoomDynamicWorkflow',
  'composePostgresqlResourcePackageProvider',
  'composePostgresqlResourcePackageCatalog',
  'createResourcePackageAtomicApplyOperations',
  'composeTaskWorkspaceQueries',
  'createCollaborationTaskAccessPort',
  'composeCollaborationRouteOperations',
  'composeWorkgroupTaskRoom',
  'composeTaskCatalog',
  'composeSystemOverviewQuery',
  'composeResourceCatalogOverviewQuery',
  'composeRunObservation',
  'composeRepositoryMirrors',
  'resizeAllNodePools',
  'resizeAllTaskFanoutSems',
  'setChildTaskBudgetCapacity',
]
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    )
      found.push(child)
  })
  return found
}
export function neutralHttpViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  for (const [path, name] of ROOTS) {
    const unit = units.find((unit) => unit.path === PREFIX + path)
    const root = unit?.source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    for (const binding of ['composeProviderAppComposition', 'composeProviderAppDeps']) {
      if (!root || calls(root, binding).length !== 1)
        errors.push(`${path}: ${name} must call ${binding} once`)
    }
  }
  const server = units.find((unit) => unit.path === PREFIX + 'server.ts')
  const http = units.find((unit) => unit.path === PREFIX + 'bootstrap/daemonHttpComposition.ts')
  const owner = http?.source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'composeProviderAppComposition',
  )
  if (!server || !http || !owner) return [...errors, 'neutral HTTP owner missing']
  for (const name of RETIRED) {
    walk(server.source, (node) => {
      if (ts.isIdentifier(node) && node.text === name) errors.push(`retired: ${name}`)
    })
  }
  walk(owner, (node) => {
    if (ts.isCallExpression(node) && /^composeDaemon/.test(node.expression.getText(http.source)))
      errors.push('neutral owner constructs a session bundle')
  })
  for (const routeSource of [server, http])
    walk(routeSource.source, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression.getText(routeSource.source)
      if (!/^mount\w*Routes$/.test(callee) && callee !== 'registerResourcePackageRoutes') return
      let parent: ts.Node | undefined = node.parent
      while (parent !== undefined && !ts.isFunctionDeclaration(parent)) parent = parent.parent
      const ownerName = parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined
      if (
        ownerName !== 'composeProviderAppDeps' &&
        ownerName !== 'mountApiRoutes' &&
        ownerName !== 'createComposedApp'
      )
        errors.push(`${ownerName ?? 'top-level'}: second route table (${callee})`)
    })
  for (const path of [
    'bootstrap/daemonStart.ts',
    'bootstrap/daemonApplication.ts',
    'bootstrap/daemonSession.ts',
    'bootstrap/daemonSessionAdapters.ts',
  ]) {
    const unit = units.find((unit) => unit.path === PREFIX + path)
    if (!unit) {
      errors.push(`${path}: required HTTP caller missing`)
      continue
    }
    for (const factory of HTTP_OWNERS)
      if (calls(unit.source, factory).length) errors.push(`${path}: HTTP owner ${factory}`)
  }
  return errors
}

describe('RFC-390 neutral HTTP binding', () => {
  const units = backendUnits(resolve(import.meta.dir, '../../../..'))
  test('scans the real backend and binds each caller exactly once', () => {
    expect(units.length).toBeGreaterThanOrEqual(2000)
    expect(neutralHttpViolations(units)).toEqual([])
  })
  test('negative fixtures reject every missing HTTP caller', () => {
    for (const path of [
      'bootstrap/daemonStart.ts',
      'bootstrap/daemonApplication.ts',
      'bootstrap/daemonSession.ts',
      'bootstrap/daemonSessionAdapters.ts',
    ]) {
      expect(neutralHttpViolations(units.filter((unit) => unit.path !== PREFIX + path))).toContain(
        `${path}: required HTTP caller missing`,
      )
    }
  })
  test('negative fixtures reject duplicate bindings, bundle reconstruction and a second route table', () => {
    const http = units.find((unit) => unit.path === PREFIX + 'bootstrap/daemonHttpComposition.ts')!
    for (const [addition, message] of [
      ['composeDaemonProviderCore({})', 'neutral owner constructs a session bundle'],
      ['mountHealthRoutes(app, {})', 'second route table'],
    ]) {
      const changed = http.text.replace(
        '  const resourcePackageBinding = composeResourcePackageBinding(input)',
        `  ${addition}
  const resourcePackageBinding = composeResourcePackageBinding(input)`,
      )
      expect(changed).not.toBe(http.text)
      expect(
        neutralHttpViolations(
          units.map((unit) => (unit === http ? sourceUnit(http.path, changed) : unit)),
        ).some((error) => error.includes(message!)),
      ).toBe(true)
    }
    const graph = units.find((unit) => unit.path === PREFIX + 'bootstrap/daemonApplication.ts')!
    const duplicate = graph.text.replace(
      'composeProviderAppDeps(http.composition)',
      '(composeProviderAppDeps(http.composition), composeProviderAppDeps(http.composition))',
    )
    expect(duplicate).not.toBe(graph.text)
    expect(
      neutralHttpViolations(
        units.map((unit) => (unit === graph ? sourceUnit(graph.path, duplicate) : unit)),
      ),
    ).toContain(
      'bootstrap/daemonApplication.ts: composeDaemonApplication must call composeProviderAppDeps once',
    )
    const fixture = [
      sourceUnit(PREFIX + 'server.ts', 'const alternate = app => mountHealthRoutes(app, {})'),
      sourceUnit(
        PREFIX + 'bootstrap/daemonHttpComposition.ts',
        'function composeProviderAppComposition() { composeDaemonProviderCore({}) }',
      ),
    ]
    expect(neutralHttpViolations(fixture)).toContain('neutral owner constructs a session bundle')
    expect(neutralHttpViolations(fixture)).toContain(
      'top-level: second route table (mountHealthRoutes)',
    )
  })
  test('one installer, shared scheduler scope, complete migration and narrow fusion inputs', () => {
    const server = units.find(
      (unit) => unit.path === PREFIX + 'bootstrap/daemonHttpComposition.ts',
    )!
    expect(calls(server.source, 'createResourcePackagePluginInstaller')).toHaveLength(1)
    expect(calls(server.source, 'composeConfigConcurrencyHotApply')).toHaveLength(1)
    expect(server.source.text).toMatch(
      /composeConfigConcurrencyHotApply\(\s*taskExecutionProvider\.processConcurrencyScope/,
    )
    expect(server.source.text).not.toContain('classicCatalogs.')
    expect(server.source.text).toContain('probeRunner: mcpRuntimeTests.probeRunner')
    expect(server.source.text).toContain('databaseTelemetry: input.databaseTelemetry')
    expect(calls(server.source, 'composeDatabaseMigrationModule')).toHaveLength(0)
    expect(server.text).toContain('operations: input.databaseMigration')
    const fusion = units.find(
      (unit) => unit.path === PREFIX + 'modules/knowledge-evolution/inbound/fusionRoutes.ts',
    )!
    const contract = fusion.source.statements.find(
      (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'FusionRouteDependencies',
    )
    if (!contract || !ts.isInterfaceDeclaration(contract))
      throw new Error('fusion route contract missing')
    expect(contract.members.map((member) => member.name?.getText(fusion.source))).toEqual([
      'operations',
      'directAuthority',
    ])
  })
  test('application precedes maintenance and supplies its apply activity to both providers', () => {
    const session = units.find((unit) => unit.path === PREFIX + 'bootstrap/daemonSession.ts')!
    const application = units.find(
      (unit) => unit.path === PREFIX + 'bootstrap/daemonApplication.ts',
    )!
    const maintenance = calls(session.source, 'createMaintenanceService')
    const graph = calls(session.source, 'composeDaemonApplication')
    const http = calls(application.source, 'composeProviderAppComposition')
    expect(maintenance).toHaveLength(1)
    expect(graph).toHaveLength(1)
    expect(http).toHaveLength(1)
    expect(graph[0]!.getStart()).toBeLessThan(maintenance[0]!.getStart())
    expect(maintenance[0]!.getText(session.source)).toContain(
      'runtime.resourcePackageActivity.activeApplyIds',
    )
    expect(graph[0]!.getText(session.source)).toContain(
      'maintenanceStatus: () => maintenanceService.status()',
    )
    expect(http[0]!.getText(application.source)).toContain('appHome: input.appHome')
    expect(http[0]!.getText(application.source)).toContain(
      'databaseTelemetry: input.provider.telemetry',
    )
    expect(application.text).toContain('resourcePackageActivity: http.resourcePackageApplyActivity')
  })
})

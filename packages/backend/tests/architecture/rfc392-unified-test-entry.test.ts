// RFC-392: prevent a second HTTP test graph, production test seams, or HTTP owners returning to the mount table.
import { expect, test } from 'bun:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const GRAPH = PREFIX + 'bootstrap/daemonApplication.ts'
const HTTP = PREFIX + 'bootstrap/daemonHttpComposition.ts'
const PURPOSE = PREFIX + 'bootstrap/developmentPurposeRoot.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'
const SERVER = PREFIX + 'server.ts'
const ENTRY = 'packages/backend/tests/helpers/providerHttpApplication.ts'
const RETIRED = [
  'AppDeps',
  'RuntimeDiagnosticTestDependencies',
  'withIntegrationTriggerResources',
  'SqliteAppComposition',
  'composeSqliteAppDeps',
  'composeSqliteApplicationDeps',
  'createApp',
]
const SEAMS = [
  'schedulerDriver',
  'buildScheduleLaunch',
  'runtimeDiagnosticTestDependencies',
  'webhookDispatcher',
  'mcpRuntimeTestDependencies',
  'intentTestDependencies',
  'workflowRuntime',
  'opencodeVersion',
  'codeHostFetch',
  'webhookTerminalControl',
  'systemOperations',
].sort()
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
export function unifiedTestEntryViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  let entries = 0
  const locations = new Map<string, string[]>()
  for (const unit of units)
    walk(unit.source, (node) => {
      if (unit.path.startsWith(PREFIX) && ts.isIdentifier(node) && RETIRED.includes(node.text))
        errors.push('retired symbol: ' + node.text)
      if (ts.isFunctionDeclaration(node) && node.name) {
        const places = locations.get(node.name.text) ?? []
        places.push(unit.path)
        locations.set(node.name.text, places)
      }
      if (
        unit.path === ENTRY &&
        ts.isCallExpression(node) &&
        node.expression.getText(unit.source) === 'composeDaemonApplication'
      )
        entries++
      if (unit.path === SERVER) {
        if (
          ts.isImportDeclaration(node) &&
          /(?:^|\/)bootstrap\//.test((node.moduleSpecifier as ts.StringLiteral).text)
        )
          errors.push('server imports bootstrap')
        if (
          ts.isCallExpression(node) &&
          /^composeDaemon/.test(node.expression.getText(unit.source))
        )
          errors.push('server constructs bundle')
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          /^deps\./.test(node.left.getText(unit.source))
        )
          errors.push('server test fallback')
      }
      if (unit.path === SESSION && ts.isIdentifier(node) && node.text === 'testSeams')
        errors.push('session supplies test seams')
    })
  if (entries !== 1) errors.push('test entry must compose exactly once')
  for (const [name, expected] of [
    ['composeProviderAppComposition', HTTP],
    ['composeDevelopmentPurposeRoot', PURPOSE],
  ] as const)
    if (JSON.stringify(locations.get(name)) !== JSON.stringify([expected]))
      errors.push('owner location: ' + name)
  const graph = units.find((unit) => unit.path === GRAPH)
  if (graph) {
    const contracts = graph.source.statements.filter(ts.isInterfaceDeclaration)
    const seams = contracts.find((node) => node.name.text === 'DaemonApplicationTestSeams')
    if (
      JSON.stringify(seams?.members.map((member) => member.name?.getText()).sort()) !==
      JSON.stringify(SEAMS)
    )
      errors.push('test seams contract')
    if (seams?.members.some((member) => !ts.isPropertySignature(member) || !member.questionToken))
      errors.push('required test seam')
    const input = contracts.find((node) => node.name.text === 'DaemonApplicationInput')
    const seamInput = input?.members.find((member) => member.name?.getText() === 'testSeams')
    if (!seamInput || !ts.isPropertySignature(seamInput) || !seamInput.questionToken)
      errors.push('test seams must be optional')
    for (const key of [
      'log',
      'applicationConfiguration',
      'taskLaunchConfiguration',
      'sourceWriteWindow',
    ]) {
      const member = input?.members.find((member) => member.name?.getText() === key)
      if (!member || !ts.isPropertySignature(member) || member.questionToken)
        errors.push('required input: ' + key)
    }
    if (input?.members.some((member) => SEAMS.includes(member.name?.getText() ?? '')))
      errors.push('flat test seam')
  } else errors.push('application graph missing')
  return errors
}
const repo = resolve(import.meta.dir, '../../../..')
test('the entire production corpus and the common test entry obey the unified boundary', () => {
  const units = backendUnits(repo)
  expect(units.length).toBeGreaterThanOrEqual(2000)
  expect(
    unifiedTestEntryViolations([
      ...units,
      sourceUnit(ENTRY, readFileSync(resolve(repo, ENTRY), 'utf8')),
    ]),
  ).toEqual([])
  const reader = readFileSync(
    resolve(repo, 'packages/backend/tests/helpers/daemonGraphSource.ts'),
    'utf8',
  )
  expect(reader).not.toContain('daemonHttpComposition.ts')
}, 30_000)
test('negative fixtures exercise every retired-path and owner-location rejection', () => {
  for (const name of RETIRED)
    expect(unifiedTestEntryViolations([sourceUnit(SERVER, `interface ${name} {}`)])).toContain(
      'retired symbol: ' + name,
    )
  for (const [path, code, error] of [
    [SERVER, "import type { X } from '@/bootstrap/x'", 'server imports bootstrap'],
    [SERVER, 'composeDaemonMemoryModules({})', 'server constructs bundle'],
    [SERVER, 'const x = deps.x ?? factory()', 'server test fallback'],
    [SESSION, 'composeDaemonApplication({testSeams: {}})', 'session supplies test seams'],
    [
      ENTRY,
      'composeDaemonApplication({}); composeDaemonApplication({})',
      'test entry must compose exactly once',
    ],
    [
      GRAPH,
      'function composeProviderAppComposition() {}',
      'owner location: composeProviderAppComposition',
    ],
    [
      SERVER,
      'function composeDevelopmentPurposeRoot() {}',
      'owner location: composeDevelopmentPurposeRoot',
    ],
  ])
    expect(unifiedTestEntryViolations([sourceUnit(path!, code!)])).toContain(error!)
})

// The selected deployment reaches server.ts as a required value; no deps fallback remains.
test('required deployment inputs and graph contracts have positive and negative controls', () => {
  const server = (mode: string) =>
    sourceUnit(
      SERVER,
      `function createHttpRequestApp(deps) { return deps.deploymentMode }
  function createComposedApp(deps) { return deps.executionAuthority${mode} }`,
    )
  expect(unifiedTestEntryViolations([server('.mode')])).not.toContain('server test fallback')
  expect(unifiedTestEntryViolations([server("?.mode ?? 'standalone'")])).toContain(
    'server test fallback',
  )
  const graph = `interface DaemonApplicationInput {
    log: unknown; applicationConfiguration: unknown; taskLaunchConfiguration: unknown;
    sourceWriteWindow: unknown; testSeams?: DaemonApplicationTestSeams
  }
  interface DaemonApplicationTestSeams { ${SEAMS.map((key) => key + '?: unknown').join(';')} }`
  const errors = (source: string) => unifiedTestEntryViolations([sourceUnit(GRAPH, source)])
  expect(errors(graph)).not.toContain('test seams contract')
  expect(errors(graph)).not.toContain('test seams must be optional')
  for (const key of [
    'log',
    'applicationConfiguration',
    'taskLaunchConfiguration',
    'sourceWriteWindow',
  ])
    expect(errors(graph.replace(key + ':', key + '?:'))).toContain('required input: ' + key)
  expect(errors(graph.replace('testSeams?:', 'testSeams:'))).toContain(
    'test seams must be optional',
  )
  expect(errors(graph.replace('codeHostFetch?:', 'codeHostFetch:'))).toContain('required test seam')
  expect(errors(graph.replace('codeHostFetch?: unknown', 'extra?: unknown'))).toContain(
    'test seams contract',
  )
})

// RFC-388: prohibit provider runtime twins and lock the three-entry deployment adapter and direct bundle assembly.
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const ADAPTERS = 'cli/daemonModules/adapters.ts'
const BUNDLE = 'cli/daemonModules/taskExecution.ts'
const RUNTIME = 'modules/task-execution/composition/providerRuntime.ts'
const RETIRED = new Set([
  'composeSqliteTaskExecutionProviderRuntime',
  'composePostgresqlTaskExecutionProviderRuntime',
  'createSqliteTaskRouteLaunchOperations',
  'createSqliteTaskExecutionLaunchParticipant',
  'createPostgresqlClarifyRepairParticipant',
  'createPostgresqlReviewRepairParticipant',
  '__setActiveTaskForTesting',
  '__registerActiveTaskForTesting',
  '__abortActiveTaskForTesting',
  'testActiveControllers',
  'composeLegacyTaskActivityParticipant',
  'composeLegacyTaskStopRegistry',
])
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function unwrap(node: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node
}
function objectKeys(node: ts.Node): string[] {
  const object = unwrap(node)
  if (!ts.isObjectLiteralExpression(object)) return []
  return object.properties.map((property) => property.name?.getText() ?? '<spread>').sort()
}
function calls(unit: SourceUnit, name: string): number {
  let count = 0
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === name) count++
  })
  return count
}
export function runtimeMergeViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  for (const unit of units) {
    if (unit.path.endsWith('/sqliteTaskRouteLaunchOperations.ts'))
      errors.push('retired launch file')
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && RETIRED.has(node.text)) errors.push(`retired: ${node.text}`)
    })
  }
  const adapters = units.find((unit) => unit.path === PREFIX + ADAPTERS)
  let table: ts.ObjectLiteralExpression | undefined
  if (adapters)
    walk(adapters.source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === 'DAEMON_TASK_EXECUTION_ADAPTERS' &&
        node.initializer
      ) {
        const value = unwrap(node.initializer)
        if (ts.isObjectLiteralExpression(value)) table = value
      }
    })
  if (!table || objectKeys(table).join(',') !== 'postgresql,sqlite')
    errors.push('adapter providers differ')
  for (const entry of table?.properties ?? []) {
    const value = ts.isPropertyAssignment(entry) ? unwrap(entry.initializer) : undefined
    if (
      !value ||
      !ts.isArrowFunction(value) ||
      objectKeys(value.body).join(',') !== 'execution,processConcurrencyScope,provider'
    )
      errors.push(`adapter entries differ: ${entry.name?.getText()}`)
  }
  const bundle = units.find((unit) => unit.path === PREFIX + BUNDLE)
  if (!bundle || calls(bundle, 'composeTaskExecutionProviderRuntime') !== 1)
    errors.push('bundle must compose runtime once')
  if (bundle && calls(bundle, 'input.adapters.compose') !== 0)
    errors.push('adapter must not compose runtime')
  const runtime = units.find((unit) => unit.path === PREFIX + RUNTIME)
  for (const name of [
    'createTaskExecutionRuntimeParticipants',
    'createTaskRouteWorkspaceParticipant',
    'createTaskRouteLaunchOperations',
    'createTaskExecutionLaunchParticipant',
    'createRootTaskLaunchKernel',
  ]) {
    if (!runtime || calls(runtime, name) !== 1) errors.push(`runtime must compose ${name} once`)
  }
  if (runtime && calls(runtime, 'createTaskDagCollaborationOperations') !== 0)
    errors.push('runtime must reuse DAG collaboration')
  return errors
}
const unit = (path: string, text: string) => sourceUnit(PREFIX + path, text)
function valid(): SourceUnit[] {
  return [
    unit(
      ADAPTERS,
      `const DAEMON_TASK_EXECUTION_ADAPTERS = {
      sqlite: ({ db }) => ({ provider: 'sqlite', execution: () => binding(db), processConcurrencyScope: db }),
      postgresql: ({ runtime }) => ({ provider: 'postgresql', execution: (p) => binding(p), processConcurrencyScope: runtime }),
    } satisfies Adapters;`,
    ),
    unit(BUNDLE, 'const runtime = composeTaskExecutionProviderRuntime(input);'),
    unit(
      RUNTIME,
      `function composeTaskExecutionProviderRuntime(input) {
      createTaskExecutionRuntimeParticipants(input); createTaskRouteWorkspaceParticipant(input);
      createTaskRouteLaunchOperations(input); createTaskExecutionLaunchParticipant(input); createRootTaskLaunchKernel(input);
    }`,
    ),
  ]
}
describe('RFC-388 runtime merge structural locks', () => {
  test('scans real backend sources and locks the production graph', () => {
    const units = backendUnits(resolve(import.meta.dir, '../../../..'))
    expect(units.length).toBeGreaterThanOrEqual(2000)
    expect(runtimeMergeViolations(units)).toEqual([])
  })
  test('compliant fixture passes', () => {
    expect(runtimeMergeViolations(valid())).toEqual([])
  })
  test.each([...RETIRED])('rejects retired entry %s anywhere in production', (name) => {
    expect(
      runtimeMergeViolations([...valid(), unit('regression.ts', `export function ${name}() {}`)]),
    ).toContain(`retired: ${name}`)
  })
  test('rejects extra adapter responsibilities, missing construction and duplicated workspace/DAG participants', () => {
    const fixtures = valid()
    fixtures[0] = unit(
      ADAPTERS,
      fixtures[0]!.source.text.replace("provider: 'sqlite',", "provider: 'sqlite', compose() {},"),
    )
    expect(runtimeMergeViolations(fixtures)).toContain('adapter entries differ: sqlite')
    fixtures[1] = unit(BUNDLE, 'const runtime = input.adapters.compose(input);')
    expect(runtimeMergeViolations(fixtures)).toContain('bundle must compose runtime once')
    fixtures[2] = unit(
      RUNTIME,
      fixtures[2]!.source.text +
        'createTaskRouteWorkspaceParticipant(input); createTaskDagCollaborationOperations(db);',
    )
    expect(runtimeMergeViolations(fixtures)).toContain(
      'runtime must compose createTaskRouteWorkspaceParticipant once',
    )
    expect(runtimeMergeViolations(fixtures)).toContain('runtime must reuse DAG collaboration')
  })
})

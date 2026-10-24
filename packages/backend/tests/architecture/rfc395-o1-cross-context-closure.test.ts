// RFC-395 II-b package O1: prevent reintroducing source-control Task SQL and the retired platform writers.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dir, '../../../..')
const read = (path: string) => readFileSync(resolve(root, 'packages/backend/src', path), 'utf8')

function taskTableBindings(text: string): string[] {
  const source = ts.createSourceFile('closure.ts', text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const forbidden = new Set(['tasks', 'taskRepos', 'nodeRuns'])
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === 'tablesOf'
    ) {
      for (const binding of node.name.elements) {
        const key = (binding.propertyName ?? binding.name).getText(source)
        if (forbidden.has(key)) hits.push(key)
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      forbidden.has(node.name.text) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === 'tablesOf'
    )
      hits.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

test('source-control persistence reads only its own Task ports', () => {
  const sources = [
    'repositoryWorkspaceSqlStore',
    'repositoryWorkspaceStore',
    'workspaceMaintenanceStore',
  ].map((name) => read('modules/source-control/infrastructure/' + name + '.ts'))
  expect(sources.length).toBe(3)
  expect(sources.flatMap(taskTableBindings)).toEqual([])
  for (const retired of [
    'platform/persistence/sqlite/taskLifecycle.ts',
    'platform/persistence/terminalWorkspacePrune.ts',
    'platform/persistence/taskRepositorySql.ts',
    'modules/source-control/infrastructure/workspaceMaintenanceSqlStore.ts',
  ])
    expect(existsSync(resolve(root, 'packages/backend/src', retired))).toBe(false)
  const adapter = read('modules/task-execution/application/adapters/source-control-adapter.ts')
  expect(adapter).toMatch(/import type[\s\S]*source-control\/composition\/required-ports/)
  expect(adapter).not.toMatch(/from ['"][^'"]*(?:infrastructure|sessionTables|db\/|drizzle-orm)/)
  expect(
    read('modules/source-control/infrastructure/repositoryWorkspaceSqlStore.ts'),
  ).not.toContain('findWorktreeTask')
})

test('negative controls catch destructured aliases and direct table bindings', () => {
  expect(
    taskTableBindings('const { tasks: legacy, taskRepos: mounts, nodeRuns } = tablesOf(db)'),
  ).toEqual(['tasks', 'taskRepos', 'nodeRuns'])
  expect(taskTableBindings('const legacy = tablesOf(db).tasks')).toEqual(['tasks'])
  expect(
    taskTableBindings(
      'const { cachedRepos } = tablesOf(db); const value = { tasks: sources.requested }',
    ),
  ).toEqual([])
})

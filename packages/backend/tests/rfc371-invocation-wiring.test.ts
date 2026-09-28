// RFC-371: every production process entry keeps the accepted runtime identity
// and bootstrap-selected participant, including internal commit/merge agents.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(resolve(import.meta.dir, '../src', path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
const properties = (object: ts.ObjectLiteralExpression) =>
  new Map(
    object.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(), p.initializer]),
  )

test('six scheduler invocation entries forward the frozen identity and selected participant', () => {
  const entries: Array<{ path: string; fields: Map<string, ts.Expression> }> = []
  for (const path of [
    'services/scheduler.ts',
    'modules/task-execution/composition/nodeMechanics.ts',
    'modules/task-execution/composition/wrapperMechanics.ts',
  ]) {
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText() === 'runNode') {
        const input = node.arguments[0]!
        expect(ts.isObjectLiteralExpression(input)).toBe(true)
        if (ts.isObjectLiteralExpression(input)) entries.push({ path, fields: properties(input) })
      }
      ts.forEachChild(node, walk)
    }
    walk(source(path))
  }
  expect(entries).toHaveLength(6)
  for (const { fields } of entries) {
    const runtime = fields
      .get('runtime')!
      .getText()
      .replace(/\.protocol$/, '')
    expect(fields.get('runtimeObservationIdentity')?.getText()).toBe(
      `${runtime}.observationIdentity`,
    )
    expect(fields.get('observationInvocations')?.getText()).toBe(
      'state.opts.observationInvocations',
    )
  }
  const system = entries.filter(
    ({ fields }) => fields.get('observationPurpose')?.getText() === "'system'",
  )
  expect(system.map(({ path }) => path).sort()).toEqual([
    'modules/task-execution/composition/nodeMechanics.ts',
    'services/scheduler.ts',
  ])
})

test('all standalone bootstraps explicitly bind local accounting', () => {
  for (const [path, database] of [
    ['cli/start.ts', 'db'],
    ['cli/postgresqlDaemonApplication.ts', 'input.db'],
    ['server.ts', 'deps.db'],
  ]) {
    let count = 0
    const walk = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'observationInvocations') {
        expect(node.initializer.getText()).toBe(`composeLocalInvocationObservations(${database})`)
        count++
      }
      ts.forEachChild(node, walk)
    }
    walk(source(path!))
    expect(count).toBe(1)
  }
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const text = readFileSync(resolve(import.meta.dir, '../src/services/runner.ts'), 'utf8')
const source = ts.createSourceFile('runner.ts', text, ts.ScriptTarget.Latest, true)
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}
const properties = (value: ts.ObjectLiteralExpression) =>
  new Map(
    value.properties
      .filter(ts.isPropertyAssignment)
      .map((item) => [item.name.getText(source), item.initializer]),
  )
test('real spawn admission precedes span baseline and actual spawn receipt precedes fresh-root binding', () => {
  let process: ts.CallExpression | undefined
  walk(source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'runAgentProcess')
      process = node
  })
  expect(process).toBeDefined()
  const argument = process!.arguments[0]!
  if (!ts.isObjectLiteralExpression(argument))
    throw new Error('Agent process input must remain reviewable')
  const fields = properties(argument),
    admission = fields.get('beforeSpawn')!.getText(source),
    spawned = fields.get('onSpawned')!.getText(source)
  expect(admission.indexOf('observationInvocations.accept')).toBeLessThan(
    admission.indexOf('nativeSpanCapture.begin'),
  )
  expect(admission).toContain('accepted.spanCaptureSource === preparedSpans.sourceNamespace')
  expect(fields.get('requireSpawnReceipt')?.getText(source)).toBe('true')
  expect(spawned).toContain('observationSpawnedAt = receipt.spawnedAt')
  const boundCalls: ts.CallExpression[] = []
  walk(source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'bindObservationRoot')
      boundCalls.push(node)
  })
  expect(boundCalls).toHaveLength(2)
  expect(boundCalls.map((node) => node.arguments[0]?.getText(source))).toEqual([
    'nativeSessionId',
    'nextSessionId',
  ])
})
test('lookup never persists asynchronously; final spans follow actual reaping and original stdout/stderr flushes', () => {
  const result = text.indexOf('processSettlement = runResult')
  const final = text.indexOf('nativeSpanCapture.finish', result)
  expect(result).toBeGreaterThan(0)
  expect(final).toBeGreaterThan(result)
  expect(text.indexOf('await stdoutEvents.flush()', result)).toBeLessThan(final)
  expect(text.indexOf('await stderrEvents.flush()', result)).toBeLessThan(final)
  expect(text.slice(result, final)).toContain("runResult.outcome !== 'unreaped'")
  const capture = readFileSync(
    resolve(import.meta.dir, '../src/modules/runtime-management/application/nativeSpanCapture.ts'),
    'utf8',
  )
  expect(capture).not.toContain('appendEvents(')
  expect(capture).not.toContain('nextRevision(')
})

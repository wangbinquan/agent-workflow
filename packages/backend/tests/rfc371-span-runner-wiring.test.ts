import { readTaskAgentSources } from './helpers/taskAgentSource'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const text = readTaskAgentSources()
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
  // RFC-370 moved the native receipt requirement into the selected binding;
  // admission and actual-start facts remain in this invocation's submit call.
  let process: ts.CallExpression | undefined
  let binding: ts.CallExpression | undefined
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'localExecution.effect.submit'
    )
      process = node
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'invocation' &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === 'bindNativeAgentInvocation'
    )
      binding = node.initializer
  })
  expect(process).toBeDefined()
  expect(binding).toBeDefined()
  expect(text).toContain('const localExecution = invocation.bindExecution(')
  const argument = process!.arguments[0]!
  if (!ts.isObjectLiteralExpression(argument))
    throw new Error('Agent process input must remain reviewable')
  const fields = properties(argument),
    admission = fields.get('beforeStart')!.getText(source),
    spawned = fields.get('onStarted')!.getText(source)
  expect(admission.indexOf('observationInvocations.accept')).toBeLessThan(
    admission.indexOf('nativeSpanCapture.begin'),
  )
  expect(admission).toContain('accepted.spanCaptureSource === preparedSpans.sourceNamespace')
  const nativeArgument = binding!.arguments[0]!
  if (!ts.isObjectLiteralExpression(nativeArgument))
    throw new Error('Native execution binding must remain reviewable')
  expect(properties(nativeArgument).get('requireSpawnReceipt')?.getText(source)).toBe('true')
  expect(spawned).toContain('observationSpawnedAt = receipt.startedAt')
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

// Two independent final writes regressed the original numeric repair rejection
// contract. Both source batches must share one final transaction, with no event replay.
test('post-reap native metadata and model corrections share one final write', () => {
  const final = text.slice(
    text.indexOf('processSettlement = runResult'),
    text.indexOf('let gitMutationViolation'),
  )
  const subtree = ts.createSourceFile('final.ts', final, ts.ScriptTarget.Latest, true)
  const writes: ts.CallExpression[] = []
  walk(subtree, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'appendEvents' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(subtree) === 'selectTaskNodeExecutionWrites'
    ) {
      const selection = node.expression.expression
      expect(selection.arguments).toHaveLength(2)
      expect(selection.arguments[0]?.getText(subtree)).toBe('opts.persistence')
      expect(selection.arguments[1]?.getText(subtree)).toBe("'issuedResults'")
      writes.push(node)
    }
  })
  expect(writes).toHaveLength(1)
  expect(final).toContain('const observations = [...modelRevisions, ...spanFacts]')
  expect(final.indexOf('nativeSpanCapture.finish')).toBeLessThan(
    final.indexOf('const observations = [...modelRevisions, ...spanFacts]'),
  )
  expect(final.indexOf('nativeUsageCapture?.finish')).toBeLessThan(
    final.indexOf('const observations = [...modelRevisions, ...spanFacts]'),
  )
  const input = writes[0]!.arguments[0]!
  if (!ts.isObjectLiteralExpression(input))
    throw new Error('Final write must use the original persistence contract')
  expect(input.properties.find(ts.isPropertyAssignment)?.initializer.getText(subtree)).toBe(
    'opts.nodeRunId',
  )
  expect(
    input.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(subtree) === 'events' &&
        property.initializer.getText(subtree) === '[]',
    ),
  ).toBe(true)
})

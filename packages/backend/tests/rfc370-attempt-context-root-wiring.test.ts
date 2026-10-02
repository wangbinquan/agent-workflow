import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )

function calls(source: ts.SourceFile, expression: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression)
      result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function binding(source: ts.SourceFile, call: ts.CallExpression, receiver: string) {
  const argument = call.arguments[0]!
  expect(ts.isObjectLiteralExpression(argument)).toBe(true)
  if (!ts.isObjectLiteralExpression(argument)) throw new Error('root binding must be explicit')
  const contexts = argument.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === 'attemptContext',
  )
  expect(contexts).toHaveLength(1)
  expect(contexts[0]!.initializer.getText(source)).toBe(`${receiver}.attemptContext`)
}

test('the actual DA composition selects one context receiver and invokes its native default lazily', () => {
  const composition = load('modules/development-automation/composition.ts')
  const native = calls(composition, 'createAttemptContextStore')
  expect(native).toHaveLength(1)
  const selection = native[0]!.parent
  expect(ts.isBinaryExpression(selection)).toBe(true)
  if (!ts.isBinaryExpression(selection)) throw new Error('context selection is missing')
  expect(selection.left.getText(composition)).toBe('deps.attemptContext')
  expect(selection.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
  expect(ts.isPropertyAssignment(selection.parent)).toBe(true)
  if (!ts.isPropertyAssignment(selection.parent)) throw new Error('port binding is missing')
  expect(selection.parent.name.getText(composition)).toBe('attemptContext')
})

test('all real startup and HTTP roots forward the same selected context through provider recomposition', () => {
  const start = load('cli/start.ts')
  const pg = load('cli/postgresqlDaemonApplication.ts')
  const server = load('server.ts')
  const pgRoot = calls(start, 'composePostgresqlDaemonApplication')
  expect(pgRoot).toHaveLength(1)
  binding(start, pgRoot[0]!, 'input')
  for (const [source, receiver] of [
    [start, 'input'],
    [pg, 'input'],
    [server, 'deps'],
  ] as const) {
    const roots = calls(source, 'composeDevelopmentAutomation')
    expect(roots).toHaveLength(1)
    binding(source, roots[0]!, receiver)
    expect(source.text).toContain('attemptContext?: AttemptContextStorePort')
  }
  const http = calls(start, 'composeSqliteAppDeps')
  expect(http).toHaveLength(1)
  binding(start, http[0]!, 'input')
  expect(start.text).toContain('attemptContext: opts.attemptContext,')
  expect(start.text).toContain('readonly attemptContext?: AttemptContextStorePort')
  expect(start.text).toContain('...sessionInput,')
})

test('the four actual context readers and both async manifest consumers await the provider ACK', () => {
  for (const [path, expression] of [
    ['pipelineEvidenceChain.ts', 'deps.ports.attemptContext.load'],
    ['missionDeliveryChain.ts', 'deps.ports.attemptContext.load'],
    ['missionReconciler.ts', 'deps.ports.attemptContext.load'],
    ['agentActionOrchestrator.ts', 'ports.attemptContext?.load'],
  ]) {
    const source = load(`modules/development-automation/application/${path}`)
    const reads = calls(source, expression!)
    expect(reads).toHaveLength(1)
    expect(ts.isAwaitExpression(reads[0]!.parent)).toBe(true)
  }
  const reconciler = load('modules/development-automation/application/missionReconciler.ts')
  for (const expression of ['loadPipelineManifest', 'pipelineRepairInputs']) {
    const consumers = calls(reconciler, expression)
    expect(consumers).toHaveLength(1)
    expect(ts.isAwaitExpression(consumers[0]!.parent)).toBe(true)
  }
})

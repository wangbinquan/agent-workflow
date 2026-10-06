import { taskAgentSource } from './helpers/taskAgentSource'
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
        const input = node.arguments[1]!
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
  for (const [path, database, historyProvider] of [
    ['cli/start.ts', 'db', 'sqlite'],
    ['cli/postgresqlDaemonApplication.ts', 'input.db', 'postgresql'],
    ['server.ts', 'deps.db', null],
  ] as const) {
    let count = 0
    const walk = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'observationInvocations') {
        // Assert the call tree, so formatting cannot invalidate an otherwise exact binding.
        const binding = node.initializer
        expect(ts.isCallExpression(binding)).toBe(true)
        if (!ts.isCallExpression(binding)) throw new Error('accounting must be a composed call')
        expect(binding.expression.getText()).toBe('composeLocalInvocationObservations')
        expect(binding.arguments).toHaveLength(2)
        expect(binding.arguments[0]?.getText()).toBe(database)
        const participant = binding.arguments[1]!
        expect(ts.isCallExpression(participant)).toBe(true)
        if (!ts.isCallExpression(participant))
          throw new Error('source must be an explicit participant')
        expect(participant.expression.getText()).toBe('composeObservationUsageSource')
        expect(participant.arguments[0]?.getText()).toBe(database)
        expect(participant.arguments).toHaveLength(historyProvider === null ? 1 : 2)
        if (historyProvider !== null) {
          const history = participant.arguments[1]!
          expect(ts.isCallExpression(history)).toBe(true)
          if (!ts.isCallExpression(history)) throw new Error('history must use the actual reader')
          expect(history.expression.getText()).toBe('nativeHistoryRead')
          expect(history.arguments).toHaveLength(1)
          const input = history.arguments[0]!
          expect(ts.isObjectLiteralExpression(input)).toBe(true)
          if (!ts.isObjectLiteralExpression(input))
            throw new Error('history source must be explicit')
          const fields = properties(input)
          expect(fields.get('provider')?.getText()).toBe(`'${historyProvider}'`)
          const shorthand = input.properties.filter(ts.isShorthandPropertyAssignment)
          if (historyProvider === 'sqlite') {
            expect([...fields.keys()].sort()).toEqual(['generationId', 'provider'])
            expect(shorthand.map((field) => field.name.text)).toEqual([database])
            expect(fields.get('generationId')?.getText()).toBe(
              'databaseProvider.generation.payload.generationId',
            )
          } else {
            expect([...fields.keys()].sort()).toEqual(['provider', 'runtime'])
            expect(shorthand).toHaveLength(0)
            expect(fields.get('runtime')?.getText()).toBe('input.provider.runtime')
          }
        }
        count++
      }
      ts.forEachChild(node, walk)
    }
    walk(source(path))
    expect(count).toBe(1)
  }
})

test('usage capture receives the effective resume identity used by the process', () => {
  const file = taskAgentSource()
  let resumed: ts.Expression | undefined
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'createInvocationUsageCapture') {
      const input = node.arguments[0]!
      if (ts.isObjectLiteralExpression(input)) resumed = properties(input).get('resumeSessionId')
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  expect(resumed?.getText()).toBe('effectiveResumeSessionId')
})

test('native model preparation uses final spawn env and local numeric retries avoid replaying stdout', () => {
  const file = taskAgentSource()
  let env: string | undefined,
    normalizers = 0,
    retries = 0
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'bindNativeAgentInvocation') {
      const input = node.arguments[0]!
      expect(ts.isObjectLiteralExpression(input)).toBe(true)
      if (ts.isObjectLiteralExpression(input)) {
        expect(properties(input).get('evidenceHooks')?.getText()).toBe('driver')
        const scope = properties(input).get('evidenceScope')!
        expect(ts.isObjectLiteralExpression(scope)).toBe(true)
        if (!ts.isObjectLiteralExpression(scope))
          throw new Error('Selected evidence scope must remain reviewable')
        const environment = properties(scope).get('environment')
        expect(environment && ts.isArrowFunction(environment)).toBe(true)
        if (environment && ts.isArrowFunction(environment)) env = environment.body.getText()
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'bindNativeAgentMaterialEvidence'
    ) {
      expect(node.arguments[0]?.getText()).toBe('driver')
      const input = node.arguments[1]!
      expect(ts.isObjectLiteralExpression(input)).toBe(true)
      if (ts.isObjectLiteralExpression(input)) {
        const environment = properties(input).get('environment')
        expect(environment && ts.isArrowFunction(environment)).toBe(true)
        if (environment && ts.isArrowFunction(environment)) env = environment.body.getText()
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'materialEvidence.prepareUsageNormalizer'
    ) {
      expect(node.arguments).toHaveLength(0)
      normalizers++
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'opts.persistence.nodeExecution.appendEvents'
    ) {
      const input = node.arguments[0]!
      if (
        ts.isObjectLiteralExpression(input) &&
        input.properties.some(ts.isShorthandPropertyAssignment)
      ) {
        const fields = properties(input)
        if (fields.get('events')?.getText() === '[]') {
          expect(fields.get('nodeRunId')?.getText()).toBe('opts.nodeRunId')
          expect(
            input.properties.filter(ts.isShorthandPropertyAssignment).map((p) => p.name.text),
          ).toEqual(['observations'])
          let parent: ts.Node | undefined = node.parent
          while (parent && !ts.isIfStatement(parent)) parent = parent.parent
          // The innermost check is the non-empty correction batch; the surrounding one is local authority.
          while (parent?.parent && !ts.isIfStatement(parent.parent)) parent = parent.parent
          expect(parent?.parent?.getText()).toContain(
            "localObservationAccepted && runResult.outcome !== 'unreaped'",
          )
          retries++
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  expect(env).toBe('plan.env')
  expect(normalizers).toBe(1)
  expect(retries).toBe(1)
})

test('native child capture freezes its contract before spawn and starts only after local acceptance', () => {
  const file = taskAgentSource(),
    text = file.getFullText()
  expect(text).toContain('materialEvidence.prepareNativeUsageCapture?.({')
  expect(text).toContain('nativeCaptureContract: nativeUsageCapture.contract')
  const accepted = text.indexOf("localObservationAccepted = accepted.authority.kind === 'local'")
  const begin = text.indexOf('nativeUsageCapture?.begin()')
  const spawnReceipt = text.indexOf('onStarted: async', accepted)
  expect(accepted).toBeGreaterThan(0)
  expect(begin).toBeGreaterThan(accepted)
  expect(begin).toBeLessThan(spawnReceipt)
  expect(text.slice(accepted, begin)).toContain('if (localObservationAccepted)')
  let requiredReceipts = 0
  const checkRequiredReceipt = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'bindNativeAgentInvocation') {
      const input = node.arguments[0]!
      expect(ts.isObjectLiteralExpression(input)).toBe(true)
      if (ts.isObjectLiteralExpression(input)) {
        expect(properties(input).get('requireSpawnReceipt')?.kind).toBe(ts.SyntaxKind.TrueKeyword)
        requiredReceipts++
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'bindLocalAgentExecutionEffect'
    ) {
      const input = node.arguments[0]!
      expect(ts.isObjectLiteralExpression(input)).toBe(true)
      if (ts.isObjectLiteralExpression(input)) {
        expect(properties(input).get('requireSpawnReceipt')?.kind).toBe(ts.SyntaxKind.TrueKeyword)
        requiredReceipts++
      }
    }
    ts.forEachChild(node, checkRequiredReceipt)
  }
  checkRequiredReceipt(file)
  expect(requiredReceipts).toBe(1)
  if (text.includes('bindNativeAgentInvocation')) {
    expect(text).toContain('const localExecution = invocation.bindExecution(')
    expect(text).toContain('const materialEvidence = invocation.evidence')
  } else {
    expect(text).toContain('const localExecution = bindLocalAgentExecutionEffect(')
    expect(text).toContain('const materialEvidence = bindNativeAgentMaterialEvidence(')
  }

  const finalCapture = text.indexOf('nativeUsageCapture?.finish(')
  expect(finalCapture).toBeGreaterThan(
    text.indexOf("localObservationAccepted && runResult.outcome !== 'unreaped'"),
  )
  let includedInFinalBatch = false
  const walk = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === 'observations' &&
      node.initializer?.getText().includes('nativeUsageCapture?.finish(')
    )
      includedInFinalBatch = true
    ts.forEachChild(node, walk)
  }
  walk(file)
  expect(includedInFinalBatch).toBe(true)
})

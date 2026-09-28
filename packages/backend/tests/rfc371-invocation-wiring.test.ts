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
        expect(participant.arguments.map((argument) => argument.getText())).toEqual([database])
        count++
      }
      ts.forEachChild(node, walk)
    }
    walk(source(path))
    expect(count).toBe(1)
  }
})

test('usage capture receives the effective resume identity used by the process', () => {
  const file = source('services/runner.ts')
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
  const file = source('services/runner.ts')
  let env: string | undefined,
    retries = 0
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'driver.prepareUsageNormalizer'
    ) {
      const input = node.arguments[0]!
      if (ts.isObjectLiteralExpression(input)) env = properties(input).get('env')?.getText()
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
  expect(retries).toBe(1)
})

test('native child capture freezes its contract before spawn and starts only after local acceptance', () => {
  const file = source('services/runner.ts'),
    text = file.getFullText()
  expect(text).toContain('driver.prepareNativeUsageCapture?.({')
  expect(text).toContain('nativeCaptureContract: nativeUsageCapture.contract')
  const accepted = text.indexOf("localObservationAccepted = accepted.authority.kind === 'local'")
  const begin = text.indexOf('nativeUsageCapture?.begin()')
  const spawnReceipt = text.indexOf('requireSpawnReceipt: true', accepted)
  expect(accepted).toBeGreaterThan(0)
  expect(begin).toBeGreaterThan(accepted)
  expect(begin).toBeLessThan(spawnReceipt)
  expect(text.slice(accepted, begin)).toContain('if (localObservationAccepted)')
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

// RFC-333 — executable inventory of the completed human-gate cutover. No
// skipped/todo witness is checked in: route-owned resume and compatibility
// failure branches must remain absent from production source.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

function parse(relativePath: string, source = read(relativePath)): ts.SourceFile {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function calls(
  relativePath: string,
  source = read(relativePath),
): Array<{
  name: string
  position: number
}> {
  const file = parse(relativePath, source)
  const found: Array<{ name: string; position: number }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression)
      if (name !== null) found.push({ name, position: node.getStart(file) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function declaredFunction(relativePath: string, name: string): string {
  const source = read(relativePath)
  const file = parse(relativePath, source)
  let match: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node
    if (match === undefined) ts.forEachChild(node, visit)
  }
  visit(file)
  if (match === undefined) throw new Error(`${relativePath}: function ${name} not found`)
  return match.getText(file)
}

function countNamedCalls(relativePath: string, name: string, source?: string): number {
  return calls(relativePath, source).filter((call) => call.name === name).length
}

function toolBlock(name: string): string {
  const source = read('packages/backend/src/mcp/tools.ts')
  const marker = `name: '${name}'`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`MCP tool ${name} not found`)
  const next = source.indexOf("\n  {\n    name: '", start + marker.length)
  return source.slice(start, next < 0 ? source.length : next)
}

describe('RFC-333 T2 current human-gate inventory', () => {
  const routes = [
    {
      file: 'packages/backend/src/routes/reviews.ts',
      command: 'submitReviewDecision',
      path: "path: '/api/reviews/:nodeRunId/decision'",
      tool: 'submit_review',
      toolPath: 'path: `/api/reviews/${enc(args.nodeRunId)}/decision`',
    },
    {
      file: 'packages/backend/src/routes/clarify.ts',
      command: 'submitClarifyDecision',
      path: "path: '/api/clarify/:nodeRunId/answers'",
      tool: 'answer_clarify',
      toolPath: 'path: `/api/clarify/${enc(args.nodeRunId)}/answers`',
    },
    {
      file: 'packages/backend/src/routes/taskQuestions.ts',
      command: 'dispatchTaskQuestions',
      path: "path: '/api/tasks/:id/questions/dispatch'",
      tool: 'dispatch_task_questions',
      toolPath: 'path: `/api/tasks/${enc(args.id)}/questions/dispatch`',
    },
  ] as const

  test('each route calls one public domain command and owns zero resumeTask calls', () => {
    const inventory = routes.map(({ file, command }) => ({
      file,
      commandCalls: countNamedCalls(file, command),
      directResumeCalls: countNamedCalls(file, 'resumeTask'),
    }))

    expect(inventory).toEqual(
      routes.map(({ file }) => ({
        file,
        commandCalls: 1,
        directResumeCalls: 0,
      })),
    )
    expect(inventory.every((row) => row.directResumeCalls === 0)).toBe(true)
  })

  test('the AST inventory ignores prose/type references and turns red if direct resume is restored', () => {
    const file = 'packages/backend/src/routes/reviews.ts'
    const source = read(file)
    const mutated = `${source}\nresumeTask()`
    expect(countNamedCalls(file, 'resumeTask', source)).toBe(0)
    expect(countNamedCalls(file, 'resumeTask', mutated)).toBe(1)
  })

  test('REST and named MCP tools still map one-to-one onto the three current commands', () => {
    for (const route of routes) {
      const routeSource = read(route.file)
      expect(routeSource).toContain(route.path)
      expect(toolBlock(route.tool)).toContain(route.toolPath)
    }
  })

  test('all three paths expose durable receipts and no optional resume failure branch', () => {
    for (const route of routes) {
      const source = read(route.file)
      expect(source).toContain('receipt:')
      expect(source).not.toContain('resumeFailure')
    }

    for (const file of [
      'packages/frontend/src/routes/reviews.detail.tsx',
      'packages/frontend/src/routes/clarify.detail.tsx',
      'packages/frontend/src/components/tasks/TaskQuestionList.tsx',
    ]) {
      expect(read(file)).not.toContain('resumeFailedAfterSubmit')
    }
  })
})

describe('RFC-333 human-gate open/park cutover inventory', () => {
  test('T6 review target: complete preparation precedes one TaskParkTx and post-commit finalization', () => {
    const dispatch = declaredFunction(
      'packages/backend/src/services/review.ts',
      'dispatchReviewNodeUnlocked',
    )
    const callInventory = calls('review-dispatch-snippet.ts', dispatch)
    const count = (name: string): number =>
      callInventory.filter((candidate) => candidate.name === name).length

    expect(count('prepareReviewGateOpen')).toBe(1)
    expect(count('parkPreparedHumanGate')).toBe(1)
    expect(count('finalizeCommittedHumanGate')).toBe(1)
    expect(count('setTaskStatus')).toBe(0)
    expect(count('submitTaskContinuationTx')).toBe(0)

    const position = (name: string): number =>
      callInventory.find((candidate) => candidate.name === name)!.position
    const prepare = position('prepareReviewGateOpen')
    const park = position('parkPreparedHumanGate')
    const finalize = position('finalizeCommittedHumanGate')
    expect(prepare).toBeLessThan(park)
    expect(park).toBeLessThan(finalize)

    const participant = declaredFunction(
      'packages/backend/src/modules/collaboration/infrastructure/sqliteHumanGateOpenParticipant.ts',
      'projectReviewGateOpenTx',
    )
    expect(participant).toContain('mintNodeRunTx(tx, {')
    expect(participant).toContain('tx.insert(docVersions)')
    expect(participant).toContain('tx.insert(nodeRunEvents)')

    const parkTx = read(
      'packages/backend/src/modules/task-execution/application/parkTaskAtHumanGate.ts',
    )
    expect(parkTx.indexOf('consumePreparedGateTx({')).toBeLessThan(
      parkTx.indexOf('this.lifecycle.transitionTx({'),
    )
  })

  test('T7 clarify target: complete preparation precedes one TaskParkTx and post-commit WS', () => {
    const create = declaredFunction(
      'packages/backend/src/services/clarify/service.ts',
      'createClarifyRound',
    )
    const callInventory = calls('clarify-create-snippet.ts', create)
    const count = (name: string): number =>
      callInventory.filter((candidate) => candidate.name === name).length

    expect(count('prepareClarifyGateOpen')).toBe(1)
    expect(count('parkPreparedHumanGate')).toBe(1)
    expect(count('mintNodeRun')).toBe(0)
    expect(count('transitionNodeRunStatus')).toBe(0)
    expect(count('dbTxSync')).toBe(0)
    expect(count('withTaskExecutionTransaction')).toBe(0)
    expect(count('setTaskStatus')).toBe(0)

    const position = (name: string): number =>
      callInventory.find((candidate) => candidate.name === name)!.position
    const prepare = position('prepareClarifyGateOpen')
    const park = position('parkPreparedHumanGate')
    const selfBroadcast = create.indexOf('broadcastSelfCreated(round')
    const crossBroadcast = create.indexOf('broadcastCrossCreated(round)')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(park).toBeGreaterThan(prepare)
    expect(selfBroadcast).toBeGreaterThan(park)
    expect(crossBroadcast).toBeGreaterThan(park)

    const participant = declaredFunction(
      'packages/backend/src/modules/collaboration/infrastructure/sqliteHumanGateOpenParticipant.ts',
      'projectClarifyGateOpenTx',
    )
    expect(participant).toContain('mintNodeRunTx(tx, {')
    expect(participant).toContain('tx.insert(clarifyRounds)')
    expect(participant).toContain('tx.insert(taskQuestions)')
    expect(participant).toContain('tx.insert(nodeRunEvents)')
  })

  test('T7 new rounds project eager questions while historical lazy reconciliation remains', () => {
    const seal = read('packages/backend/src/services/clarify/seal.ts')
    const questions = read('packages/backend/src/services/taskQuestions.ts')
    const participant = read(
      'packages/backend/src/modules/collaboration/infrastructure/sqliteHumanGateOpenParticipant.ts',
    )
    expect(participant).toContain('tx.insert(taskQuestions)')
    expect(seal).toContain('reconcileRoundEntriesTx(tx, {')
    expect(questions).toContain('export function reconcileRoundEntriesTx(')
  })

  test('T7 manual questions persist one operation and defer active-owner park to settle', () => {
    const create = declaredFunction(
      'packages/backend/src/services/taskQuestions.ts',
      'createManualTaskQuestion',
    )
    const createCalls = calls('manual-question-create-snippet.ts', create)
    expect(
      createCalls.filter((candidate) => candidate.name === 'createManualQuestionOpen'),
    ).toHaveLength(1)
    expect(createCalls.filter((candidate) => candidate.name === 'dbTxSync')).toHaveLength(0)
    expect(create).not.toContain('insert(taskQuestions)')

    const creation = read(
      'packages/backend/src/modules/collaboration/infrastructure/sqliteManualQuestionOpenWriter.ts',
    )
    expect(creation).toContain('this.operations.beginTx({')
    expect(creation).toContain('tx.insert(taskQuestions).values(question).run()')
    expect(creation).toContain('this.operations.markPreparedTx({')

    const engine = read(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    expect(engine.match(/settleManualQuestionParkObligations\(\{/g)).toHaveLength(4)
    expect(engine).toContain('onTransitionTx: (tx) =>')
    expect(engine).toContain('assertNoManualQuestionParkObligationTx(tx, taskId, humanGates)')
    expect(engine).toContain("if (statusBeforeReviewPark === 'awaiting_human')")
    expect(engine).toContain("reason: 'active-clarify-released-before-review'")
    expect(engine).toContain('task review outcome yielded to a durable manual question')

    const operationStore = read(
      'packages/backend/src/modules/collaboration/infrastructure/sqliteHumanGateOperationStore.ts',
    )
    expect(operationStore).toContain(
      "ne(collaborationGateOperations.operationKind, 'manual-question-open')",
    )
  })
})

describe('RFC-333 T2 canonical continuation authority lock', () => {
  test('the legacy resume helper already reaches the RFC-328 public participant and gate intent kind', () => {
    const task = read('packages/backend/src/services/task.ts')
    const bridge = read('packages/backend/src/services/taskExecutionParticipants.ts')
    const participants = read('packages/backend/src/modules/task-execution/public/participants.ts')
    const submit = read(
      'packages/backend/src/modules/task-execution/application/submitTaskContinuation.ts',
    )

    expect(bridge).toContain("export * from '@/modules/task-execution/public/participants'")
    expect(participants).toContain(
      'export const submitTaskContinuationTx = submitTaskContinuationTxInternal',
    )
    expect(task).toContain('submitTaskContinuationTx(input.tx, input)')
    expect(task.match(/intentKind: 'gate-continuation'/g)?.length).toBe(2)
    expect(submit).toContain('taskExecutionModule.intents.submitTx({')
  })
})

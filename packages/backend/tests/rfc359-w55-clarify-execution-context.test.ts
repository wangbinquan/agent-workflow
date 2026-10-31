import type { TaskExecutionParticipantBindings } from '@/modules/collaboration/infrastructure/taskExecutionParticipantBindings'
import { expect, test } from 'bun:test'
import { composeHumanGateTaskLockPort } from '@/modules/task-execution/composition'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

type RecordValue = Record<string, unknown>
type Open = (input: RecordValue) => Promise<RecordValue>

// These entry cases only open a gate; unrelated write participants must stay unused.
function unusedParticipant(): never {
  throw new Error('unexpected task participant construction while opening clarify')
}
const taskExecutionParticipants: TaskExecutionParticipantBindings = {
  createTaskNodeStatusEventsParticipantInTx: unusedParticipant,
  createHumanGateNodeRunStateParticipantInTx: unusedParticipant,
  createTaskDecisionParticipantInTx: unusedParticipant,
  createHumanGateNodeRunMintParticipantInTx: unusedParticipant,
  createHumanGateTaskTransitionParticipantInTx: unusedParticipant,
  createHumanGateNodeRunMintOperations: unusedParticipant,
  createTaskAuthorizationQueries: unusedParticipant,
  createTaskAuthorizationParticipantInTx: unusedParticipant,
}

// Execute the complete production entry functions with explicit fake ports.
// Loading their modules would initialize real application/DB dependencies.
function extract<T>(path: string, name: string, ports: RecordValue): T {
  const source = readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
  if (declaration === undefined) throw new Error(`Missing production function ${name}`)
  let text = declaration.getText(ast).replace(/^export /, '')
  if (name === 'createCollaborationRuntimeMechanics') {
    const lazyImport = "await import('./clarify/service')"
    expect(text.split(lazyImport)).toHaveLength(3)
    text = text.replaceAll(lazyImport, 'await loadClarify()')
  }
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(text)
  const bind = new Function(...Object.keys(ports), `${js}\nreturn ${name}`) as (
    ...values: unknown[]
  ) => T
  return bind(...Object.values(ports))
}

function fixture(ambient: object | undefined, parkFailure?: Error) {
  const taskTable = { id: 'task-id', name: 'name', workflowSnapshot: 'snapshot' }
  const roundTable = { id: 'round-id' }
  const stored = { id: 'round', intermediaryNodeRunId: 'gate-run' }
  const parks: RecordValue[] = []
  const prepared: RecordValue[] = []
  const received: RecordValue[] = []
  const ambientReads: unknown[] = []
  const queried: unknown[] = []
  // RFC-399 A8: parking receives collaboration's human-gate open scope factory explicitly.
  const humanGateOpenScope = () => ({})
  const db = {
    select() {
      let table: unknown
      const query = {
        from(value: unknown) {
          table = value
          queried.push(value)
          return query
        },
        where() {
          return query
        },
        orderBy() {
          return query
        },
        async limit() {
          if (table === taskTable)
            return [{ name: 'task', workflowSnapshot: '{"nodes":[]}', lifecycleEventRevision: 7 }]
          return parks.length > 0 ? [stored] : []
        },
      }
      return query
    },
  }
  const createRound = extract<Open>(
    'modules/collaboration/infrastructure/clarify/service.ts',
    'createClarifyRound',
    {
      ClarifyEnvelopeBodySchema: { parse: (value: unknown) => value },
      ClarifyQuestionSchema: { parse: (value: unknown) => value },
      findSelfGateRunForShard: async () => undefined,
      tablesOf: (handle: unknown) => {
        expect(handle).toBe(db)
        return { tasks: taskTable, clarifyRounds: roundTable }
      },
      // RFC-395 II-a A7: bind the moved task-definition read with the same query accounting.
      createTaskGateQueries: (handle: unknown) => {
        expect(handle).toBe(db)
        return {
          async listDefinitionContexts(ids: string[]) {
            expect(ids).toEqual(['task'])
            queried.push(taskTable)
            return [{ name: 'task', workflowSnapshot: '{"nodes":[]}', lifecycleEventRevision: 7 }]
          },
        }
      },
      eq: () => undefined,
      and: () => undefined,
      desc: () => undefined,
      kindIs: () => undefined,
      frameIs: () => undefined,
      sha256Hex: (value: string) => value,
      currentTaskExecutionContext: (taskId: unknown) => {
        ambientReads.push(taskId)
        return ambient
      },
      createHumanGateOpenParticipantScope: humanGateOpenScope,
      createCollaborationCommandContext: (input: RecordValue) => {
        expect(input.db).toBe(db)
        expect(input.taskLock).toBe(composeHumanGateTaskLockPort)
        return {}
      },
      async parkPreparedHumanGate(input: RecordValue) {
        expect(input.humanGateOpen).toBe(humanGateOpenScope)
        parks.push(input)
        if (parkFailure !== undefined) throw parkFailure
      },
      prepareClarifyGateOpen: async (_context: unknown, input: RecordValue) => {
        prepared.push(input)
        return {
          kind: 'prepared',
          prepared: { taskId: input.taskId },
          roundId: 'round',
          nodeRunId: 'gate-run',
        }
      },
      readClarifyAnswerProjection: async () => [],
      rowToRound: (row: unknown) => row,
      log: { warn() {} },
    },
  )
  const compose = extract<
    (
      database: object,
      dependencies: {
        taskLock: typeof composeHumanGateTaskLockPort
        taskExecutionParticipants: TaskExecutionParticipantBindings
      },
    ) => {
      openAgentClarify: Open
    }
  >(
    'modules/collaboration/infrastructure/collaborationRuntimeMechanics.ts',
    'createCollaborationRuntimeMechanics',
    {
      isTaskClarifySuppressed: () => false,
      dismissOpenClarifyParksForAutonomous: () => undefined,
      loadClarify: async () => ({
        createClarifyRound: (input: RecordValue) => {
          received.push(input)
          return createRound(input)
        },
      }),
    },
  )
  return {
    // RFC-395 O2: use the same required-port factory as crossContextClosure.ts.
    open: compose(db, { taskLock: composeHumanGateTaskLockPort, taskExecutionParticipants })
      .openAgentClarify,
    parks,
    prepared,
    received,
    ambientReads,
    queried,
    db,
  }
}

function input(kind: 'self' | 'cross', context?: object): RecordValue {
  return {
    kind,
    taskId: 'task',
    askingNodeId: 'agent',
    askingNodeRunId: 'agent-run',
    intermediaryNodeId: 'gate',
    frame: { containerRunId: 'wrapper', iteration: 3 },
    questions: [{ id: 'q', title: 'Question' }],
    ...(kind === 'self'
      ? { askingShardKey: null, iteration: 2 }
      : { targetConsumerNodeId: 'consumer', loopIter: 3 }),
    ...(context === undefined ? {} : { executionContext: context }),
  }
}

for (const kind of ['self', 'cross'] as const) {
  test(`clarify ${kind} preserves the explicit execution context through round parking`, async () => {
    for (const ambient of [undefined, { task: 'another-context' }]) {
      const context = Object.freeze({ task: 'current-execution' })
      const h = fixture(ambient)
      const result = await h.open(input(kind, context))
      expect(h.received[0]?.taskLock).toBe(composeHumanGateTaskLockPort)
      expect(h.received[0]?.executionContext).toBe(context)
      expect(h.parks[0]?.executionContext).toBe(context)
      expect(h.parks[0]?.db).toBe(h.db)
      expect(h.ambientReads).toEqual([])
      expect(h.prepared[0]?.containerRunId).toBe('wrapper')
      expect(h.prepared[0]?.iteration).toBe(kind === 'self' ? 2 : 0)
      expect(result).toEqual({ intermediaryNodeRunId: 'gate-run' })
    }
  })

  test(`clarify ${kind} retains ambient and ownerless fallback for legacy callers`, async () => {
    for (const ambient of [{ task: 'ambient-execution' }, undefined]) {
      const h = fixture(ambient)
      await h.open(input(kind))
      expect(Object.hasOwn(h.received[0]!, 'executionContext')).toBe(false)
      expect(h.ambientReads).toEqual(['task'])
      expect(h.parks[0]?.executionContext).toBe(ambient)
      expect(Object.hasOwn(h.parks[0]!, 'executionContext')).toBe(ambient !== undefined)
    }
  })

  test(`clarify ${kind} propagates a parking failure before reading a round projection`, async () => {
    const error = new Error('park failed')
    const h = fixture(undefined, error)
    await expect(h.open(input(kind, {}))).rejects.toBe(error)
    expect(h.parks).toHaveLength(1)
    expect(h.queried).toHaveLength(kind === 'self' ? 1 : 2)
  })
}

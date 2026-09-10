import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

type RecordValue = Record<string, unknown>
type Open = (input: RecordValue) => Promise<RecordValue>

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
          if (table === taskTable) return [{ name: 'task', lifecycleEventRevision: 7 }]
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
      tasks: taskTable,
      clarifyRounds: roundTable,
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
      humanGateComposition: {
        createCollaborationCommandContext: () => ({}),
        async parkPreparedHumanGate(input: RecordValue) {
          parks.push(input)
          if (parkFailure !== undefined) throw parkFailure
        },
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
      rowToRound: (row: unknown) => row,
      log: { warn() {} },
    },
  )
  const compose = extract<(database: object) => { openAgentClarify: Open }>(
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
    open: compose(db).openAgentClarify,
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

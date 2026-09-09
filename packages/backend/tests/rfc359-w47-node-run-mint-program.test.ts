// RFC-359 W47: one mint program must retain both callers' terminal and completion contracts.
// These extracted-function controls execute no database or record/path derivation helper.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

import {
  driveAsyncProgram,
  driveSyncProgram,
  executeTransactionStepSync,
  transactionStep,
} from '@/platform/persistence/transactionProgram'

type Mode = 'sync' | 'async'
type Stage = 'record' | 'container' | 'task' | 'prior' | 'abandon' | 'insert'
interface Scenario {
  readonly name: string
  readonly scopePath: string | null
  readonly containerRunId: string | null
  readonly lineageSlotPathJson: string | null
  readonly shardKey: string | null
  readonly priorIds: readonly string[]
  readonly missingContainer?: boolean
}

const scenarios: readonly Scenario[] = [
  {
    name: 'explicit',
    scopePath: 'scope',
    containerRunId: null,
    lineageSlotPathJson: '[]',
    shardKey: null,
    priorIds: [],
  },
  {
    name: 'derived',
    scopePath: null,
    containerRunId: 'container',
    lineageSlotPathJson: null,
    shardKey: 'shard',
    priorIds: ['older-a', 'older-b'],
  },
  {
    name: 'root',
    scopePath: null,
    containerRunId: null,
    lineageSlotPathJson: null,
    shardKey: null,
    priorIds: [],
  },
  {
    name: 'missing-container',
    scopePath: null,
    containerRunId: 'missing',
    lineageSlotPathJson: '[]',
    shardKey: null,
    priorIds: ['older'],
    missingContainer: true,
  },
]

const infrastructure = resolve(import.meta.dir, '../src/modules/task-execution/infrastructure')
const nativeSource = readFileSync(
  resolve(infrastructure, 'sqliteNodeRunMintParticipant.ts'),
  'utf8',
)
const neutralSource = readFileSync(resolve(infrastructure, 'nodeRunMintParticipant.ts'), 'utf8')

/** Remove only type syntax/imports; do not print or reconstruct the runtime function tree. */
function runtimeSource(text: string): string {
  const source = ts.createSourceFile('mint.ts', text, ts.ScriptTarget.Latest, true)
  const ranges: Array<readonly [number, number]> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      ranges.push([node.getStart(source), node.end])
      return
    }
    if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      ranges.push([node.expression.end, node.end])
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isParameter(node)) {
      if (node.type !== undefined) {
        const start = text.lastIndexOf(':', node.type.pos)
        if (start < node.getStart(source)) throw new Error('missing type annotation delimiter')
        ranges.push([start, node.type.end])
      }
    }
    if (ts.canHaveModifiers(node)) {
      for (const modifier of ts.getModifiers(node) ?? []) {
        if (modifier.kind === ts.SyntaxKind.ExportKeyword)
          ranges.push([modifier.getStart(source), modifier.end])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let result = text
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
    result = result.slice(0, start) + result.slice(end)
  return result
}

function evaluate(text: string, ports: Record<string, unknown>, expression: string): unknown {
  const factory = new Function(
    ...Object.keys(ports),
    `${runtimeSource(text)}\nreturn (${expression});`,
  )
  return factory(...Object.values(ports))
}

function encode(value: unknown): unknown {
  if (value === undefined) return { undefined: true }
  if (Array.isArray(value)) return value.map(encode)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
  }
  return value
}

export const mintControlRecords: unknown[] = []

function control(mode: Mode, scenario: Scenario, options: { fail?: Stage; hold?: Stage } = {}) {
  const events: unknown[] = []
  const completed: Stage[] = []
  const failure = new Error(`controlled ${options.fail ?? 'unused'} failure`)
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld
  })
  const holding = new Promise<void>((resolveEntered) => {
    entered = resolveEntered
  })
  const input = Object.freeze({ control: scenario.name })
  const record = Object.freeze({
    id: 'minted-id',
    taskId: 'task',
    nodeId: 'node',
    iteration: 2,
    parentNodeRunId: null,
    containerRunId: scenario.containerRunId,
    scopePath: scenario.scopePath,
    lineageSlotPathJson: scenario.lineageSlotPathJson,
    shardKey: scenario.shardKey,
    continuationSlotKey: null,
    untouchedJson: '{"a":[null,1]}',
    untouchedNull: null,
  })
  let inserted: unknown
  let abandoned: unknown
  const log = (operation: string, ...args: unknown[]): void => {
    events.push(encode({ operation, args }))
  }
  const finish = (stage: Stage, value: unknown): unknown => {
    log('terminal', stage)
    completed.push(stage)
    if (stage === options.fail) throw failure
    if (mode === 'async') {
      if (stage === options.hold) {
        entered?.()
        return held.then(() => value)
      }
      return Promise.resolve(value)
    }
    return value
  }
  const nodeRuns = Object.fromEntries(
    [
      'id',
      'taskId',
      'nodeId',
      'scopePath',
      'iteration',
      'containerRunId',
      'parentNodeRunId',
      'shardKey',
      'mergeState',
    ].map((key) => [key, `nodeRuns.${key}`]),
  )
  const tasks = {
    id: 'tasks.id',
    lineageSlotPathJson: 'tasks.lineageSlotPathJson',
    workflowVersion: 'tasks.workflowVersion',
  }
  const tx = {
    select(projection: Record<string, string>) {
      log('select', projection)
      const stage =
        'nodeId' in projection ? 'container' : 'workflowVersion' in projection ? 'task' : 'prior'
      const result =
        stage === 'container'
          ? scenario.missingContainer
            ? undefined
            : { nodeId: 'container-node', scopePath: 'parent-scope' }
          : stage === 'task'
            ? { lineageSlotPathJson: '[{"task":"frame"}]', workflowVersion: 3 }
            : scenario.priorIds.map((id) => ({ id }))
      return {
        from(table: unknown) {
          log('from', table)
          return {
            where(predicate: unknown) {
              log('where', predicate)
              return {
                get() {
                  log('get', stage)
                  return finish(stage, result)
                },
                all() {
                  log('all', stage)
                  return finish(stage, result)
                },
                then(
                  resolveValue: (value: unknown) => unknown,
                  rejectValue: (error: unknown) => unknown,
                ) {
                  log('then', stage)
                  return Promise.resolve()
                    .then(() => finish(stage, result))
                    .then(resolveValue, rejectValue)
                },
              }
            },
          }
        },
      }
    },
    update(table: unknown) {
      log('update', table)
      return {
        set(values: unknown) {
          log('set', values)
          abandoned = values
          return {
            where(predicate: unknown) {
              log('where', predicate)
              return {
                run() {
                  return finish('abandon', { changes: 2 })
                },
              }
            },
          }
        },
      }
    },
    insert(table: unknown) {
      log('insert', table)
      return {
        values(values: unknown) {
          log('values', values)
          inserted = values
          return {
            run() {
              return finish('insert', { changes: 1 })
            },
          }
        },
      }
    },
  }
  const ports: Record<string, unknown> = {
    nodeRuns,
    tasks,
    transactionStep,
    driveAsyncProgram,
    driveSyncProgram,
    executeTransactionStepSync,
    buildNodeRunMintRecord(value: unknown) {
      log('record', value, value === input)
      if (options.fail === 'record') throw failure
      return record
    },
    childScopePath(...args: unknown[]) {
      log('childScopePath', ...args)
      return 'derived-scope'
    },
    nodeRunLineageColumns(value: unknown, task: unknown) {
      log('nodeRunLineageColumns', value, task, value === record)
      return { continuationSlotKey: 'lineage-key', lineageSlotPathJson: '[{"mint":"frame"}]' }
    },
  }
  for (const operation of ['and', 'eq', 'inArray', 'isNull', 'lt', 'or']) {
    ports[operation] = (...args: unknown[]) => ({ operation, args })
  }
  const shared = evaluate(
    neutralSource,
    ports,
    'typeof nodeRunMintProgram === "function" ? nodeRunMintProgram : undefined',
  )
  const factory = evaluate(
    mode === 'sync' ? nativeSource : neutralSource,
    { ...ports, nodeRunMintProgram: shared },
    mode === 'sync' ? 'createSqliteNodeRunMintParticipantInTx' : 'createNodeRunMintParticipantInTx',
  )
  if (typeof factory !== 'function') throw new Error('missing actual mint factory')
  const participant: unknown = factory(tx)
  if (
    participant === null ||
    typeof participant !== 'object' ||
    !('mint' in participant) ||
    typeof participant.mint !== 'function'
  )
    throw new Error('missing mint method')
  const mint = participant.mint
  return {
    events,
    completed,
    failure,
    holding,
    release() {
      release?.()
    },
    mint(): unknown {
      return mint(input)
    },
    snapshot(result: unknown) {
      const value = encode({ scenario: scenario.name, mode, result, events, inserted, abandoned })
      mintControlRecords.push(value)
      return value
    },
    expectedValues: {
      ...record,
      scopePath:
        scenario.scopePath ??
        (scenario.containerRunId === null || scenario.missingContainer ? '' : 'derived-scope'),
      continuationSlotKey: 'lineage-key',
      lineageSlotPathJson: '[{"mint":"frame"}]',
    },
    get inserted() {
      return inserted
    },
    get abandoned() {
      return abandoned
    },
  }
}

describe('RFC-359 W47 node-run mint completion contracts', () => {
  test('both entries preserve complete inserted values and conditional operation order', async () => {
    for (const scenario of scenarios) {
      for (const mode of ['sync', 'async'] as const) {
        const run = control(mode, scenario)
        const pending = run.mint()
        expect(pending instanceof Promise).toBe(mode === 'async')
        const result = await pending
        expect(result).toBe('minted-id')
        expect(run.inserted).toEqual(run.expectedValues)
        expect(run.abandoned).toEqual(
          scenario.priorIds.length === 0 ? undefined : { mergeState: 'abandoned' },
        )
        expect<readonly string[]>(run.completed).toEqual([
          ...(scenario.scopePath === null && scenario.containerRunId !== null ? ['container'] : []),
          ...(scenario.lineageSlotPathJson === null ? ['task'] : []),
          'prior',
          ...(scenario.priorIds.length === 0 ? [] : ['abandon']),
          'insert',
        ])
        const terminal = encode({ operation: mode === 'sync' ? 'all' : 'then', args: ['prior'] })
        expect(run.events).toContainEqual(terminal)
        run.snapshot(result)
      }
    }
  })

  test('native errors remain immediate and asynchronous errors reject with the same identity', async () => {
    const scenario = scenarios[1]!
    for (const stage of ['record', 'container', 'task', 'prior', 'abandon', 'insert'] as const) {
      for (const mode of ['sync', 'async'] as const) {
        const run = control(mode, scenario, { fail: stage })
        let error: unknown
        let returned: unknown
        try {
          returned = run.mint()
        } catch (caught) {
          error = caught
        }
        if (mode === 'sync') {
          expect(error).toBe(run.failure)
          expect(returned).toBeUndefined()
        } else {
          expect(error).toBeUndefined()
          expect(returned).toBeInstanceOf(Promise)
          try {
            await returned
          } catch (caught) {
            error = caught
          }
          expect(error).toBe(run.failure)
        }
        const allStages: readonly Stage[] = ['container', 'task', 'prior', 'abandon', 'insert']
        expect(run.completed).toEqual(
          stage === 'record' ? [] : allStages.slice(0, allStages.indexOf(stage) + 1),
        )
        run.snapshot({
          sameError: error === run.failure,
          name: run.failure.name,
          message: run.failure.message,
        })
      }
    }
  })

  test('every asynchronous terminal finishes before the following operation or returned id', async () => {
    const stages: readonly Stage[] = ['container', 'task', 'prior', 'abandon', 'insert']
    for (const stage of stages) {
      const run = control('async', scenarios[1]!, { hold: stage })
      const pending = run.mint()
      let settled = false
      const complete = Promise.resolve(pending).then((value) => {
        settled = true
        return value
      })
      await run.holding
      await new Promise<void>((resume) => setImmediate(resume))
      expect(settled).toBe(false)
      expect(run.completed).toEqual(stages.slice(0, stages.indexOf(stage) + 1))
      run.release()
      expect(await complete).toBe('minted-id')
      expect<readonly Stage[]>(run.completed).toEqual(stages)
      run.snapshot({ heldStage: stage, result: 'minted-id' })
    }
  })
})

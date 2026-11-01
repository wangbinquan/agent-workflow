// RFC-409: the DAG scope interpreter (engine/scope/runScope.ts) runs on ports the composition binds over
// one execution state — the root's or a wrapper's nested state. These cases lock the binding: every fact
// is read from the current state, node execution and auto commit&push stay the composition's
// implementations, and `driveDagScope` (the former runScope entry) drives a scope through those ports.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createDagScopePorts,
  driveDagScope,
} from '@/modules/task-execution/composition/taskDagScope'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'

type Calls = Record<string, unknown[]>

function recorder(calls: Calls, name: string, result: unknown = undefined) {
  return (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args.length === 1 ? args[0] : args)
    return Promise.resolve(result)
  }
}

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as never

function fixture() {
  const calls: Calls = {}
  const persistence = (label: string) => ({
    selection: {
      label: label + ':selection',
      currentInFrame: recorder(calls, label + ':currentInFrame', new Map()),
      familyHistory: recorder(calls, label + ':familyHistory', []),
    },
    nodeExecution: { label: label + ':nodeExecution', list: recorder(calls, label + ':list', []) },
    nodeRuns: { label: label + ':nodeRuns' },
    intents: { label: label + ':intents', hasPendingGateSuccessor: recorder(calls, 'gate', false) },
  })
  const raw = {
    taskId: 'task-1',
    task: { id: 'task-row-1', autoCommitPush: false },
    definition: { $schema_version: 6, name: 'wf', nodes: [], edges: [] } as unknown,
    topLevelIds: new Set<string>(['a']),
    containerOf: new Map<string, string>(),
    opts: {
      executionContext: undefined as unknown,
      signal: undefined as AbortSignal | undefined,
      persistence: persistence('p-1') as unknown,
      taskDagCollaboration: {
        autoDispatchDeferredQuestions: recorder(calls, 'deferred'),
        loadOpenClarifyEvidence: recorder(calls, 'openClarify', {
          clarifyNodeIds: new Set(),
          askingRunIds: new Set(),
        }),
        loadUndispatchedParkTargets: recorder(calls, 'parkTargets', new Set()),
      } as unknown,
    },
  }
  const state = raw as unknown as TaskMechanicsState
  return { raw, state, calls, persistence }
}

test('facts, persistence and the collaboration projection are read from the current state on use', () => {
  const { raw, state, persistence } = fixture()
  const ports = createDagScopePorts(state, () => ({}) as never)
  expect(ports.task.taskId).toBe('task-1')
  expect(ports.task.rowId).toBe('task-row-1')
  expect(ports.task.autoCommitPush).toBe(false)
  raw.task.autoCommitPush = true
  expect(ports.task.autoCommitPush).toBe(true)
  expect(ports.task.topLevelIds).toBe(raw.topLevelIds)
  const nested = new Set(['b'])
  raw.topLevelIds = nested
  expect(ports.task.topLevelIds).toBe(nested)
  expect(ports.task.containerOf).toBe(raw.containerOf)
  expect(ports.task.definition).toBe(raw.definition as never)
  expect(ports.execution).toBeUndefined()
  const context = { sentinel: 'context-1' }
  raw.opts.executionContext = context
  expect(ports.execution).toBe(context as never)
  const controller = new AbortController()
  raw.opts.signal = controller.signal
  expect(ports.signal).toBe(controller.signal)
  raw.opts.persistence = persistence('p-2')
  expect((ports.persistence.selection as unknown as { label: string }).label).toBe('p-2:selection')
  expect((ports.persistence.nodeExecution as unknown as { label: string }).label).toBe(
    'p-2:nodeExecution',
  )
  expect((ports.persistence.nodeRuns as unknown as { label: string }).label).toBe('p-2:nodeRuns')
  expect((ports.persistence.intents as unknown as { label: string }).label).toBe('p-2:intents')
  expect(ports.collaboration).toBe(raw.opts.taskDagCollaboration as never)
})

test('driveDagScope runs one quiescent scope through the bound ports', async () => {
  const { state, calls } = fixture()
  const outcome = await driveDagScope(
    state,
    { scopeId: null, scopeIds: new Set(), containerRunId: null, iteration: 0, log },
    () => ({}) as never,
  )
  expect(outcome.kind).toBe('ok')
  // One frontier tick: deferred questions, the node_run list, open clarify, park targets, then the
  // frame read inside deriveFrontier — every read went through the state's current members.
  expect(calls.deferred).toEqual(['task-1'])
  expect(calls['p-1:list']).toEqual([{ taskId: 'task-1' }])
  expect(calls.openClarify).toEqual(['task-1'])
  expect(calls.parkTargets).toEqual(['task-1'])
  expect(calls['p-1:currentInFrame']).toEqual([['task-1', { containerRunId: null, iteration: 0 }]])
  // Ownerless fixture: no gate-successor read; no auto commit&push resume at a non-commit-push task.
  expect(calls.gate).toBeUndefined()
  expect(calls['p-1:familyHistory']).toBeUndefined()
})

test('node execution and auto commit&push stay the composition implementations', () => {
  const binding = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/taskDagScope.ts'),
    'utf8',
  )
  expect(binding).toContain(
    'executeNode: (input) => executeNode(state, input, wrapperRuntimeFactory),',
  )
  expect(binding).toContain(
    'runAutoCommitPush(createAutoCommitPushPorts(state), node, iteration, log),',
  )
  // RFC-412: the commit&push tail is an engine body on its own ports.
  expect(binding).toContain(
    "import { runAutoCommitPush } from '../engine/node/commit-push/runCommitPush'",
  )
  expect(binding).toContain("import { executeNode } from './nodeExecution'")
})

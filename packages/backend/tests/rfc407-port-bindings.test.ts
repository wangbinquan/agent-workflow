// RFC-407: the fan-out shard / aggregator lines (RFC-287 L5 / L6) joined the agent-single executor's
// ports. The capabilities only they use are bound in composition to the same implementations the
// lines used to reach from wrapperMechanics.ts — candidate-row reads, the subprocess pool, the shard
// value hash, the source-port kind read, the adopted-execution flag and the shard undo — and every
// value is still read when a line asks for it.
import { expect, test } from 'bun:test'
import { declaredPorts } from '@agent-workflow/shared'
import { createAgentNodeExecutionPorts } from '@/modules/task-execution/composition/agentNodeExecution'
import { workspaceView } from '@/modules/task-execution/infrastructure/isolationWorkspaceView'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'
import { sha256Hex } from '@/util/hash'
import { AGENT_BINDING_SOURCE } from './helpers/executionMechanismSources'

type Calls = Record<string, unknown[]>

function recorder(calls: Calls, name: string, result: unknown = undefined) {
  return (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args.length === 1 ? args[0] : args)
    return Promise.resolve(result)
  }
}

const GIT_NODE = { id: 'git', kind: 'wrapper-git' }

function fixture() {
  const calls: Calls = {}
  const persistence = (label: string) => ({
    nodeExecution: {
      listOutputs: recorder(calls, label + ':listOutputs', [{ portName: 'out', content: label }]),
    },
    selection: { shardSet: recorder(calls, label + ':shardSet', { label }) },
  })
  const raw = {
    taskId: 'task-1',
    definition: {
      nodes: [{ id: 'src', kind: 'agent-single', agentId: 'agent-1' }, GIT_NODE],
      edges: [],
    } as { nodes: Record<string, unknown>[]; edges: unknown[] },
    subprocessSem: { name: 'sub-1' } as unknown,
    taskExecutionResources: {
      injection: recorder(calls, 'injection', {
        kind: 'ok',
        spec: { agent: { id: 'agent-1', outputKinds: { items: 'list<string>' } } },
      }) as (agentId: string) => Promise<unknown>,
    },
    opts: { persistence: persistence('p-1') as unknown },
  }
  return { raw, state: raw as unknown as TaskMechanicsState, calls, persistence }
}

test('candidate-row reads go straight to the persistence current at call time', async () => {
  const { raw, state, calls, persistence } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(await ports.ledger.listOutputs('run-1')).toEqual([
    { portName: 'out', content: 'p-1' },
  ] as never)
  expect(calls['p-1:listOutputs']).toEqual(['run-1'])
  const wrapper = { wrapperRunId: 'wrapper-1', iteration: 0, shards: [] }
  expect(await ports.ledger.shardSet('task-1', wrapper as never)).toEqual({ label: 'p-1' } as never)
  expect(calls['p-1:shardSet']).toEqual([['task-1', wrapper]])
  expect((calls['p-1:shardSet']![0] as unknown[])[1]).toBe(wrapper)

  raw.opts.persistence = persistence('p-2')
  await ports.ledger.listOutputs('run-2')
  await ports.ledger.shardSet('task-1', wrapper as never)
  expect(calls['p-2:listOutputs']).toEqual(['run-2'])
  expect(calls['p-2:shardSet']).toHaveLength(1)
  expect(calls['p-1:listOutputs']).toHaveLength(1)
  expect(calls['p-1:shardSet']).toHaveLength(1)
})

test('the subprocess pool is read on use; the shard value hash is the shared sha256', () => {
  const { raw, state } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(ports.subprocessSem).toBe(raw.subprocessSem as never)
  raw.subprocessSem = { name: 'sub-2' }
  expect(ports.subprocessSem).toBe(raw.subprocessSem as never)
  expect(ports.rules.shardValueHash).toBe(sha256Hex)
  expect(ports.rules.shardValueHash('value')).toBe(sha256Hex('value'))
})

test('sourcePortKind: an agent source reads its declared kind from the session; other kinds use the port table', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(await ports.resources.sourcePortKind('src', 'items')).toBe('list<string>')
  expect(await ports.resources.sourcePortKind('src', 'other')).toBeNull()
  expect(calls.injection).toEqual(['agent-1', 'agent-1'])

  // A non-agent producer answers through the shared port table (no session read).
  const declared = declaredPorts(GIT_NODE as never, raw.definition as never, {}).dataOutputs.find(
    (port) => port.name === 'git_diff',
  )?.kind
  expect(declared).toBeDefined()
  expect(await ports.resources.sourcePortKind('git', 'git_diff')).toBe(declared!)
  expect(await ports.resources.sourcePortKind('missing', 'items')).toBeNull()
  expect(calls.injection).toHaveLength(2)

  // A failed resolution, or an agent node without a canonical id, has no kind.
  raw.taskExecutionResources.injection = recorder(calls, 'injection-2', { kind: 'failed' })
  expect(await ports.resources.sourcePortKind('src', 'items')).toBeNull()
  expect(calls['injection-2']).toEqual(['agent-1'])
  raw.definition = { nodes: [{ id: 'src', kind: 'agent-single' }], edges: [] }
  expect(await ports.resources.sourcePortKind('src', 'items')).toBeNull()
  expect(calls['injection-2']).toHaveLength(1)
})

function retainedHandle(adoptedExecution: boolean | undefined, undo: (input: unknown) => unknown) {
  const calls: unknown[] = []
  const scope = {
    undoShard(input: unknown) {
      calls.push(input)
      return undo(input)
    },
  }
  const workspace = {
    taskId: 'task-1',
    key: 'iso-1',
    dbNodeRunId: 'run-1',
    workspaceRef: '/iso-1',
    passthrough: false,
    repositories: [],
    ...(adoptedExecution === undefined ? {} : { adoptedExecution }),
  }
  return { handle: workspaceView(scope as never, workspace as never), calls }
}

test('adoptedExecution and undoShard read the retained workspace record of the handle', async () => {
  const { state } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(ports.workspace.adoptedExecution(retainedHandle(true, () => true).handle)).toBe(true)
  expect(ports.workspace.adoptedExecution(retainedHandle(false, () => true).handle)).toBe(false)
  expect(ports.workspace.adoptedExecution(retainedHandle(undefined, () => true).handle)).toBe(false)

  const input = { priorNodeCommit: 'prior-a', priorBaseCommit: 'base-a' }
  const sync = retainedHandle(undefined, () => false)
  expect(ports.workspace.undoShard(sync.handle, input as never)).toBe(false)
  expect(sync.calls).toEqual([input])
  expect(sync.calls[0]).toBe(input)
  const async = retainedHandle(undefined, async () => true)
  expect(await ports.workspace.undoShard(async.handle, input as never)).toBe(true)

  // A handle the isolation view never produced has no record, exactly as before the move.
  expect(() => ports.workspace.adoptedExecution({ repos: [] } as never)).toThrow(
    'Task isolation workspace has no retained scope',
  )
})

test('the moved line delegates keep their kernel calls and fall back to the task log', () => {
  // The interrupted-merge completion runs the recovery owner on the current task state.
  expect(AGENT_BINDING_SOURCE).toContain(
    'completeInterruptedMerge: (run, log) => completeInterruptedMerge(state, run, log),',
  )
  // Each line passes its own child log; without one the task log is used, as before.
  for (const delegate of [
    /createIsoUnderLock: \(isoKeyRunId, log\) =>\s*createIsoUnderLock\(\{[\s\S]{0,260}log: log \?\? state\.log,/,
    /mergeBackAndSettle: \(input\) =>\s*mergeBackAndSettle\(\{[\s\S]{0,160}\.\.\.input,\s*log: input\.log \?\? state\.log,/,
    /markMergeFailed\(isolatedRunBinding\(state\), nodeRunId, message, log \?\? state\.log\)/,
    /discardNodeIso\(bindIsolationCleanup\(\), handle, log \?\? state\.log, state\.writeSem\)/,
  ])
    expect(AGENT_BINDING_SOURCE).toMatch(delegate)
})

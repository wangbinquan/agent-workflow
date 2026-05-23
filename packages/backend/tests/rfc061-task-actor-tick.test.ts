// RFC-061 PR-B — taskActorTick (decision core) integration tests.
//
// Verifies that computeTickActions routes each NodeKind through the
// right handler + translates DispatchResult into the right events.
// No DB, no opencode subprocess — pure decision logic exercised against
// synthetic event logs.

import { describe, expect, test } from 'bun:test'

import {
  computeTickActions,
  type TickContext,
  type ReadyScope,
} from '../src/scheduler-v2/taskActorTick'
import type { Event, Scope, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 }

function priorTaskEvent(taskId = 't1'): Event<'task-started'> {
  return {
    id: 'evt_seed',
    taskId,
    ts: 0,
    kind: 'task-started',
    nodeId: null,
    loopIter: null,
    shardKey: null,
    iter: null,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload: {},
  }
}

const emptyWorkflow: WorkflowDefinition = {
  $schema_version: 4,
  nodes: [],
  edges: [],
  inputs: [],
} as unknown as WorkflowDefinition

function baseCtx(over: Partial<TickContext> = {}): TickContext {
  return {
    taskId: 't1',
    workflow: emptyWorkflow,
    events: [priorTaskEvent()],
    readyScopes: [],
    inputsMap: {},
    repoPath: '/repo',
    readUpstreamPort: async () => null,
    resolveUpstreamInputs: async () => [],
    ...over,
  }
}

describe('computeTickActions — input', () => {
  test('input → virtual-done writes attempt-output-captured + logical-run-completed', async () => {
    const node = { id: 'n1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(
      baseCtx({ readyScopes: ready, inputsMap: { topic: 'hello' } }),
    )
    expect(out.spawnRequests).toHaveLength(0)
    const kinds = out.eventsToWrite.map((e) => e.kind)
    expect(kinds).toEqual(['attempt-output-captured', 'logical-run-completed'])
    const cap = out.eventsToWrite[0]!
    if (cap.kind === 'attempt-output-captured') {
      expect(cap.payload.portName).toBe('topic')
      expect(cap.payload.content).toBe('hello')
    }
  })

  test('input → fail-direct writes logical-run-canceled when inputKey missing', async () => {
    const node = { id: 'n1', kind: 'input' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.eventsToWrite).toHaveLength(1)
    expect(out.eventsToWrite[0]!.kind).toBe('logical-run-canceled')
  })
})

describe('computeTickActions — agent-single', () => {
  test('produces spawn-attempt + attempt-started event', async () => {
    const node = {
      id: 'n1',
      kind: 'agent-single',
      agentName: 'mAlice',
      promptTemplate: 'do {{x}}',
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(
      baseCtx({
        readyScopes: ready,
        resolveUpstreamInputs: async () => [{ portName: 'x', content: 'thing' }],
      }),
    )
    expect(out.spawnRequests).toHaveLength(1)
    const req = out.spawnRequests[0]!
    expect(req.agentName).toBe('mAlice')
    expect(req.prompt).toContain('do thing')
    expect(req.attemptId).toMatch(/^att_/)
    expect(out.eventsToWrite).toHaveLength(1)
    const ev = out.eventsToWrite[0]!
    expect(ev.kind).toBe('attempt-started')
    expect(ev.attemptId).toBe(req.attemptId)
  })

  test('agent-single missing agentName → fail-direct event', async () => {
    const node = { id: 'n1', kind: 'agent-single' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.spawnRequests).toHaveLength(0)
    expect(out.eventsToWrite[0]!.kind).toBe('logical-run-canceled')
  })
})

describe('computeTickActions — output', () => {
  test('reads upstream port, emits attempt-output-captured + logical-run-completed', async () => {
    const node = {
      id: 'n1',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'agent', portName: 'result' } }],
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(
      baseCtx({
        readyScopes: ready,
        readUpstreamPort: async () => 'hello world',
      }),
    )
    const kinds = out.eventsToWrite.map((e) => e.kind)
    expect(kinds).toEqual(['attempt-output-captured', 'logical-run-completed'])
  })

  test('output noop when upstream not ready → no events written', async () => {
    const node = {
      id: 'n1',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'agent', portName: 'result' } }],
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.eventsToWrite).toHaveLength(0)
  })
})

describe('computeTickActions — wrappers', () => {
  test('wrapper-git → enter-inner-scope writes logical-run-created event', async () => {
    const node = { id: 'wg', kind: 'wrapper-git' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.eventsToWrite).toHaveLength(1)
    const ev = out.eventsToWrite[0]!
    expect(ev.kind).toBe('logical-run-created')
    expect(ev.nodeId).toBe('wg')
  })

  test('wrapper-loop → inner scope at loopIter=current.iter', async () => {
    const node = { id: 'wl', kind: 'wrapper-loop' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: { ...baseScope, iter: 2 }, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    const ev = out.eventsToWrite[0]!
    expect(ev.kind).toBe('logical-run-created')
    expect(ev.loopIter).toBe(2)
    expect(ev.iter).toBe(0)
  })

  test('wrapper-fanout with empty shard list → fail-direct (logical-run-canceled)', async () => {
    const node = { id: 'wf', kind: 'wrapper-fanout' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.eventsToWrite).toHaveLength(1)
    expect(out.eventsToWrite[0]!.kind).toBe('logical-run-canceled')
  })
})

describe('computeTickActions — suspend-direct', () => {
  test('review dispatch → suspension-created event via SignalKindHandler', async () => {
    const node = {
      id: 'rv',
      kind: 'review',
      docPort: { nodeId: 'd', portName: 'p' },
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(
      baseCtx({
        readyScopes: ready,
        readUpstreamPort: async () => 'doc body',
      }),
    )
    const ev = out.eventsToWrite[0]!
    expect(ev.kind).toBe('suspension-created')
    if (ev.kind === 'suspension-created') {
      expect(ev.payload.signalKind).toBe('review')
    }
  })
})

describe('computeTickActions — clarify variants', () => {
  test('clarify → virtual-done with logical-run-completed only', async () => {
    const node = { id: 'cl', kind: 'clarify' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    // virtual-done with empty outputs emits only logical-run-completed.
    expect(out.eventsToWrite).toHaveLength(1)
    expect(out.eventsToWrite[0]!.kind).toBe('logical-run-completed')
  })

  test('clarify-cross-agent → virtual-done in default state', async () => {
    const node = { id: 'cca', kind: 'clarify-cross-agent' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const out = await computeTickActions(baseCtx({ readyScopes: ready }))
    expect(out.eventsToWrite[0]!.kind).toBe('logical-run-completed')
  })
})

describe('computeTickActions — batching', () => {
  test('multiple ready scopes → all dispatched in one tick', async () => {
    const nA = { id: 'a', kind: 'input', inputKey: 'a' } as unknown as WorkflowNode
    const nB = { id: 'b', kind: 'input', inputKey: 'b' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [
      { scope: { ...baseScope, nodeId: 'a' }, node: nA },
      { scope: { ...baseScope, nodeId: 'b' }, node: nB },
    ]
    const out = await computeTickActions(
      baseCtx({ readyScopes: ready, inputsMap: { a: '1', b: '2' } }),
    )
    expect(out.eventsToWrite).toHaveLength(4)
    const completed = out.eventsToWrite.filter((e) => e.kind === 'logical-run-completed')
    expect(completed).toHaveLength(2)
  })

  test('empty readyScopes → no actions', async () => {
    const out = await computeTickActions(baseCtx({ readyScopes: [] }))
    expect(out.eventsToWrite).toHaveLength(0)
    expect(out.spawnRequests).toHaveLength(0)
  })
})

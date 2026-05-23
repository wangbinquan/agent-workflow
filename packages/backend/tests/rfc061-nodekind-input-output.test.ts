// RFC-061 PR-B — unit tests for input / output NodeKindHandler.
//
// These tests lock the dispatch contracts spelled out in
// design/RFC-061-execution-event-sourced/design.md §5 + §11. They are
// pure logic — no DB, no opencode subprocess — exercising the handler
// methods directly with synthetic contexts.

import { describe, expect, test } from 'bun:test'

import { inputNodeKindHandler, type InputDispatchContext } from '../src/handlers/nodeKind/input'
import {
  outputNodeKindHandler,
  readBindings,
  type OutputDispatchContext,
} from '../src/handlers/nodeKind/output'
import type { WorkflowNode, Scope } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 }

const baseDispatchCtx = {
  scope: baseScope,
  events: [],
  prompt: { selfClarifyQA: '', externalFeedback: '', reviewComments: '' },
}

describe('input NodeKindHandler', () => {
  test('returns virtual-done with value when inputKey present', async () => {
    const node = { id: 'in1', kind: 'input', inputKey: 'task_desc' } as unknown as WorkflowNode
    const ctx: InputDispatchContext = {
      ...baseDispatchCtx,
      node,
      inputsMap: { task_desc: 'build feature X' },
    }
    const result = await inputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('virtual-done')
    if (result.kind === 'virtual-done') {
      expect(result.outputs).toEqual({ task_desc: 'build feature X' })
    }
  })

  test('empty value tolerated (input may be optional)', async () => {
    const node = { id: 'in2', kind: 'input', inputKey: 'maybe' } as unknown as WorkflowNode
    const ctx: InputDispatchContext = { ...baseDispatchCtx, node, inputsMap: {} }
    const result = await inputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('virtual-done')
    if (result.kind === 'virtual-done') {
      expect(result.outputs).toEqual({ maybe: '' })
    }
  })

  test('missing inputKey → fail-direct', async () => {
    const node = { id: 'in3', kind: 'input' } as unknown as WorkflowNode
    const ctx: InputDispatchContext = { ...baseDispatchCtx, node, inputsMap: {} }
    const result = await inputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('fail-direct')
    if (result.kind === 'fail-direct') {
      expect(result.errorMessage).toContain('missing inputKey')
    }
  })

  test('port name matches inputKey (RFC-004 canvas edge resolution)', async () => {
    const node = { id: 'in4', kind: 'input', inputKey: 'gitUrl' } as unknown as WorkflowNode
    const ctx: InputDispatchContext = {
      ...baseDispatchCtx,
      node,
      inputsMap: { gitUrl: 'git@x.com:y/z' },
    }
    const result = await inputNodeKindHandler.dispatch(ctx)
    if (result.kind !== 'virtual-done') throw new Error('expected virtual-done')
    expect(Object.keys(result.outputs)).toEqual(['gitUrl'])
  })

  test('onAttemptFinished throws (input has no attempts)', async () => {
    await expect(
      inputNodeKindHandler.onAttemptFinished(
        { scope: baseScope, attemptId: 'a1', events: [] },
        { kind: 'success' },
      ),
    ).rejects.toThrow('has no attempts')
  })
})

describe('output NodeKindHandler', () => {
  test('happy path: reads bound port content, returns virtual-done', async () => {
    const node = {
      id: 'out1',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'agent', portName: 'result' } }],
    } as unknown as WorkflowNode
    const ctx: OutputDispatchContext = {
      ...baseDispatchCtx,
      node,
      readUpstreamPort: async (n, p) => (n === 'agent' && p === 'result' ? 'hello' : null),
    }
    const result = await outputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('virtual-done')
    if (result.kind === 'virtual-done') {
      expect(result.outputs).toEqual({ final: 'hello' })
    }
  })

  test('multiple bindings supported', async () => {
    const node = {
      id: 'out2',
      kind: 'output',
      ports: [
        { name: 'a', bind: { nodeId: 'n1', portName: 'pa' } },
        { name: 'b', bind: { nodeId: 'n2', portName: 'pb' } },
      ],
    } as unknown as WorkflowNode
    const ctx: OutputDispatchContext = {
      ...baseDispatchCtx,
      node,
      readUpstreamPort: async (n, _p) => (n === 'n1' ? 'A' : 'B'),
    }
    const result = await outputNodeKindHandler.dispatch(ctx)
    if (result.kind !== 'virtual-done') throw new Error('expected virtual-done')
    expect(result.outputs).toEqual({ a: 'A', b: 'B' })
  })

  test('missing upstream port → noop with explicit reason', async () => {
    const node = {
      id: 'out3',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'agent', portName: 'result' } }],
    } as unknown as WorkflowNode
    const ctx: OutputDispatchContext = {
      ...baseDispatchCtx,
      node,
      readUpstreamPort: async () => null,
    }
    const result = await outputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('noop')
    if (result.kind === 'noop') {
      expect(result.reason).toContain('not ready')
    }
  })

  test('empty bindings list → virtual-done with empty outputs', async () => {
    const node = { id: 'out4', kind: 'output', ports: [] } as unknown as WorkflowNode
    const ctx: OutputDispatchContext = {
      ...baseDispatchCtx,
      node,
      readUpstreamPort: async () => null,
    }
    const result = await outputNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('virtual-done')
    if (result.kind === 'virtual-done') {
      expect(result.outputs).toEqual({})
    }
  })

  test('readBindings handles malformed entries gracefully', () => {
    const node = {
      ports: [
        { name: 'ok', bind: { nodeId: 'n', portName: 'p' } },
        'not-an-object',
        { name: 'no-bind' }, // missing bind
        { name: 42, bind: { nodeId: 'n', portName: 'p' } }, // wrong name type
        { bind: { nodeId: 'n', portName: 'p' } }, // missing name
      ],
    } as unknown as WorkflowNode
    const result = readBindings(node, 'ports')
    expect(result).toEqual([{ name: 'ok', bind: { nodeId: 'n', portName: 'p' } }])
  })
})

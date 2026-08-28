import {
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  SYNTHESIZED_ONLY_NODE_KINDS,
  type Agent,
  type NodeKind,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import type {
  NodeStepOutcome,
  NodeStepRequest,
} from '../src/modules/task-execution/domain/nodeExecution'
import type {
  AgentNodeExecutor,
  NodeExecutor,
  NodeExecutorMap,
} from '../src/modules/task-execution/engine/node/nodeExecutor'
import {
  ClosedNodeExecutorRegistry,
  NODE_EXECUTOR_SPECS,
} from '../src/modules/task-execution/engine/node/nodeExecutorRegistry'
import { NodeExecutionGateway } from '../src/modules/task-execution/engine/node/nodeExecutionGateway'

const OK: NodeStepOutcome = { kind: 'ok', summary: '', message: '' }

function fakeExecutor<K extends NodeKind>(kind: K): NodeExecutor<K> {
  return { kind, execute: async () => OK }
}

function fakeExecutors(): NodeExecutorMap {
  return Object.fromEntries(NODE_KIND.map((kind) => [kind, fakeExecutor(kind)])) as NodeExecutorMap
}

function request<K extends NodeKind>(kind: K, signal?: AbortSignal): NodeStepRequest<K> {
  return {
    node: { id: `node-${kind}`, kind } as WorkflowNode & { readonly kind: K },
    task: { taskId: 'task-1' },
    scope: { scopeId: null },
    iteration: 0,
    execution: { signal },
  }
}

describe('RFC-334 closed NodeKind inventory', () => {
  test('schema, behavior and executor specs expose the exact same 14 keys', () => {
    expect(NODE_KIND).toHaveLength(14)
    expect(Object.keys(NODE_KIND_BEHAVIORS).sort()).toEqual([...NODE_KIND].sort())
    expect(Object.keys(NODE_EXECUTOR_SPECS).sort()).toEqual([...NODE_KIND].sort())
    expect(SYNTHESIZED_ONLY_NODE_KINDS).toEqual(['code-round'])
    for (const kind of NODE_KIND) expect(NODE_EXECUTOR_SPECS[kind].kind).toBe(kind)
  })

  test('missing, extra and wrong-kind runtime mutations fail construction', () => {
    const exact = fakeExecutors()
    const missing = { ...exact } as Record<string, NodeExecutor>
    delete missing.output
    expect(() => new ClosedNodeExecutorRegistry(missing as NodeExecutorMap)).toThrow(
      'node-executor-registry-keys',
    )
    expect(
      () =>
        new ClosedNodeExecutorRegistry({
          ...exact,
          synthetic: fakeExecutor('input'),
        } as unknown as NodeExecutorMap),
    ).toThrow('node-executor-registry-keys')
    expect(
      () =>
        new ClosedNodeExecutorRegistry({
          ...exact,
          review: fakeExecutor('clarify'),
        } as unknown as NodeExecutorMap),
    ).toThrow('node-executor-registry-kind-mismatch:review')
  })

  test('registry snapshots the supplied record and cannot be changed afterward', () => {
    const supplied = fakeExecutors()
    const registry = new ClosedNodeExecutorRegistry(supplied)
    const original = registry.resolve('input')
    ;(supplied as unknown as Record<string, NodeExecutor>).input = fakeExecutor('input')
    expect(registry.resolve('input')).toBe(original)
    expect(Object.isFrozen(NODE_EXECUTOR_SPECS)).toBe(true)
  })
})

describe('RFC-334 NodeExecutionGateway ordering', () => {
  test('abort short-circuits branch judgment and executor effects', async () => {
    let branchHits = 0
    let executorHits = 0
    const executors = {
      ...fakeExecutors(),
      input: {
        kind: 'input',
        execute: async () => {
          executorHits += 1
          return OK
        },
      },
    } satisfies NodeExecutorMap
    const gateway = new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
      judge: async () => {
        branchHits += 1
        return { kind: 'active' }
      },
    })
    const controller = new AbortController()
    controller.abort()
    expect(await gateway.executeNode(request('input', controller.signal))).toEqual({
      kind: 'canceled',
      summary: 'task canceled',
      message: 'signal aborted',
    })
    expect(branchHits).toBe(0)
    expect(executorHits).toBe(0)
  })

  test('inactive branch returns its persisted outcome without executing the kind', async () => {
    let executorHits = 0
    const executors = {
      ...fakeExecutors(),
      output: {
        kind: 'output',
        execute: async () => {
          executorHits += 1
          return OK
        },
      },
    } satisfies NodeExecutorMap
    const skipped = { kind: 'ok', summary: '', message: 'branch-skipped' } as const
    const gateway = new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
      judge: async () => ({ kind: 'inactive', outcome: skipped }),
    })
    expect(await gateway.executeNode(request('output'))).toEqual(skipped)
    expect(executorHits).toBe(0)
  })

  test('clarify family skips branch judgment and resolves its exact executor', async () => {
    let branchHits = 0
    let clarifyHits = 0
    const executors = {
      ...fakeExecutors(),
      clarify: {
        kind: 'clarify',
        execute: async () => {
          clarifyHits += 1
          return OK
        },
      },
    } satisfies NodeExecutorMap
    const gateway = new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
      judge: async () => {
        branchHits += 1
        return { kind: 'active' }
      },
    })
    expect(await gateway.executeNode(request('clarify'))).toEqual(OK)
    expect(branchHits).toBe(0)
    expect(clarifyHits).toBe(1)
  })

  test('host lane resolves only the agent-single executor capability', async () => {
    const agent: AgentNodeExecutor = {
      kind: 'agent-single',
      execute: async () => OK,
      executeHost: async () => ({ status: 'done', outputs: { answer: 'ok' } }),
    }
    const executors = { ...fakeExecutors(), 'agent-single': agent } satisfies NodeExecutorMap
    const gateway = new NodeExecutionGateway(new ClosedNodeExecutorRegistry(executors), {
      judge: async () => ({ kind: 'active' }),
    })
    expect(
      await gateway.executeHost({
        lane: 'workgroup-host',
        task: { taskId: 'task-1' },
        host: {
          nodeRunId: 'run-1',
          nodeId: '__wg_leader__',
          agent: {} as Agent,
          promptTemplate: 'lead',
        },
        execution: {},
      }),
    ).toEqual({ status: 'done', outputs: { answer: 'ok' } })
  })
})

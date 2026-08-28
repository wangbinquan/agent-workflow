import { NODE_KIND, type NodeKind } from '@agent-workflow/shared'
import type { NodeExecutor, NodeExecutorMap } from './nodeExecutor'

export type NodeExecutorSpecMap = {
  readonly [K in NodeKind]: Readonly<{ kind: K }>
}

/**
 * Closed production inventory. It describes which executor entries must be
 * supplied; composition binds the implementations and cannot register extras.
 */
export const NODE_EXECUTOR_SPECS = Object.freeze({
  'agent-single': Object.freeze({ kind: 'agent-single' }),
  input: Object.freeze({ kind: 'input' }),
  output: Object.freeze({ kind: 'output' }),
  'wrapper-git': Object.freeze({ kind: 'wrapper-git' }),
  'wrapper-loop': Object.freeze({ kind: 'wrapper-loop' }),
  'wrapper-fanout': Object.freeze({ kind: 'wrapper-fanout' }),
  review: Object.freeze({ kind: 'review' }),
  clarify: Object.freeze({ kind: 'clarify' }),
  'clarify-cross-agent': Object.freeze({ kind: 'clarify-cross-agent' }),
  'call-workflow': Object.freeze({ kind: 'call-workflow' }),
  'call-workgroup': Object.freeze({ kind: 'call-workgroup' }),
  script: Object.freeze({ kind: 'script' }),
  'code-host-call': Object.freeze({ kind: 'code-host-call' }),
  'code-round': Object.freeze({ kind: 'code-round' }),
}) satisfies NodeExecutorSpecMap

function assertClosedRegistry(executors: Readonly<NodeExecutorMap>): void {
  const actual = Object.keys(executors).sort()
  const expected = [...NODE_KIND].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`node-executor-registry-keys:${actual.join(',')}`)
  }
  for (const kind of NODE_KIND) {
    if (executors[kind].kind !== kind) {
      throw new Error(`node-executor-registry-kind-mismatch:${kind}`)
    }
  }
}

export class ClosedNodeExecutorRegistry {
  private readonly executors: Readonly<NodeExecutorMap>

  constructor(executors: Readonly<NodeExecutorMap>) {
    assertClosedRegistry(executors)
    this.executors = Object.freeze({ ...executors })
  }

  resolve<K extends NodeKind>(kind: K): NodeExecutor<K> {
    return this.executors[kind]
  }
}

// RFC-061 PR-B — unit tests for wrapper-git / wrapper-loop / wrapper-fanout
// NodeKindHandlers.
//
// Locks the dispatch + onInnerScopeCompleted contracts from design.md §11.

import { describe, expect, test } from 'bun:test'

import {
  wrapperGitNodeKindHandler,
  type WrapperGitDispatchContext,
  type WrapperGitInnerCompletedContext,
} from '../src/handlers/nodeKind/wrapperGit'
import {
  parseExitCondition,
  parseMaxIterations,
  wrapperLoopNodeKindHandler,
  type WrapperLoopDispatchContext,
  type WrapperLoopInnerCompletedContext,
} from '../src/handlers/nodeKind/wrapperLoop'
import {
  wrapperFanoutNodeKindHandler,
  type WrapperFanoutDispatchContext,
  type WrapperFanoutInnerCompletedContext,
  type WrapperFanoutReadyContext,
} from '../src/handlers/nodeKind/wrapperFanout'
import type { WorkflowNode, Scope, Event } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'w', loopIter: 0, shardKey: '', iter: 0 }
const basePromptCtx = { selfClarifyQA: '', externalFeedback: '', reviewerFeedback: '' }

describe('wrapper-git NodeKindHandler', () => {
  test('dispatch → enter-inner-scope with same coords as wrapper', async () => {
    const node = { id: 'wg', kind: 'wrapper-git' } as unknown as WorkflowNode
    let snapshotCalled = false
    const ctx: WrapperGitDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      snapshotWorktree: async () => {
        snapshotCalled = true
        return 'sha1234'
      },
    }
    const r = await wrapperGitNodeKindHandler.dispatch(ctx)
    expect(r.kind).toBe('enter-inner-scope')
    if (r.kind === 'enter-inner-scope') {
      expect(r.innerScope.nodeId).toBe('wg')
      expect(r.innerScope.loopIter).toBe(0)
      expect(r.innerScope.shardKey).toBe('')
      expect(r.innerScope.iter).toBe(0)
    }
    expect(snapshotCalled).toBe(true)
  })

  test('onInnerScopeCompleted → done with git_diff output', async () => {
    const ctx: WrapperGitInnerCompletedContext = {
      scope: baseScope,
      innerScope: baseScope,
      events: [],
      preSnapshot: 'sha-before',
      computeDiffSinceSnapshot: async () => 'a.ts\nb.ts',
    }
    const r = await wrapperGitNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      expect(r.outputs.git_diff).toBe('a.ts\nb.ts')
    }
  })

  test('onAttemptFinished must not be called for wrappers', async () => {
    await expect(
      wrapperGitNodeKindHandler.onAttemptFinished(
        { scope: baseScope, attemptId: 'a', events: [] },
        { kind: 'success' },
      ),
    ).rejects.toThrow('has no direct attempts')
  })
})

describe('wrapper-loop NodeKindHandler', () => {
  test('dispatch promotes own iter to inner loopIter', async () => {
    const node = { id: 'wl', kind: 'wrapper-loop' } as unknown as WorkflowNode
    const ctx: WrapperLoopDispatchContext = {
      scope: { ...baseScope, iter: 3 },
      events: [],
      prompt: basePromptCtx,
      node,
    }
    const r = await wrapperLoopNodeKindHandler.dispatch(ctx)
    if (r.kind !== 'enter-inner-scope') throw new Error('expected enter-inner-scope')
    expect(r.innerScope.loopIter).toBe(3)
    expect(r.innerScope.iter).toBe(0)
  })

  test('onInnerScopeCompleted: exit condition true → done with exit outputs', async () => {
    const ctx: WrapperLoopInnerCompletedContext = {
      scope: baseScope,
      innerScope: { ...baseScope, loopIter: 0, iter: 5 },
      events: [],
      evaluateExitCondition: async () => true,
      readExitOutputs: async () => ({ final: 'OK' }),
      maxIterations: 10,
      currentIter: 0,
    }
    const r = await wrapperLoopNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      expect(r.outputs).toEqual({ final: 'OK' })
    }
  })

  test('onInnerScopeCompleted: max iterations reached → done', async () => {
    const ctx: WrapperLoopInnerCompletedContext = {
      scope: baseScope,
      innerScope: baseScope,
      events: [],
      evaluateExitCondition: async () => false,
      readExitOutputs: async () => ({ x: 'last' }),
      maxIterations: 3,
      currentIter: 2, // iter+1 == max → terminal
    }
    const r = await wrapperLoopNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('done')
  })

  test('onInnerScopeCompleted: not at exit + budget left → request-retry-auto (loop-continue)', async () => {
    const ctx: WrapperLoopInnerCompletedContext = {
      scope: baseScope,
      innerScope: baseScope,
      events: [],
      evaluateExitCondition: async () => false,
      readExitOutputs: async () => ({}),
      maxIterations: 10,
      currentIter: 0,
    }
    const r = await wrapperLoopNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('request-retry-auto')
    if (r.kind === 'request-retry-auto') {
      expect(r.reason).toBe('loop-continue')
    }
  })

  test('parseExitCondition: port-empty / port-equals / port-count-lt', () => {
    expect(
      parseExitCondition({
        exitCondition: { kind: 'port-empty', nodeId: 'n', portName: 'p' },
      } as unknown as WorkflowNode),
    ).toEqual({ kind: 'port-empty', nodeId: 'n', portName: 'p' })
    expect(
      parseExitCondition({
        exitCondition: { kind: 'port-equals', nodeId: 'n', portName: 'p', value: 'OK' },
      } as unknown as WorkflowNode),
    ).toEqual({ kind: 'port-equals', nodeId: 'n', portName: 'p', value: 'OK' })
    expect(
      parseExitCondition({
        exitCondition: { kind: 'port-count-lt', nodeId: 'n', portName: 'p', threshold: 5 },
      } as unknown as WorkflowNode),
    ).toEqual({ kind: 'port-count-lt', nodeId: 'n', portName: 'p', threshold: 5 })
  })

  test('parseExitCondition: malformed → null', () => {
    expect(parseExitCondition({} as unknown as WorkflowNode)).toBeNull()
    expect(
      parseExitCondition({ exitCondition: { kind: 'unknown' } } as unknown as WorkflowNode),
    ).toBeNull()
  })

  test('parseMaxIterations: default 10', () => {
    expect(parseMaxIterations({} as unknown as WorkflowNode)).toBe(10)
    expect(parseMaxIterations({ maxIterations: 25 } as unknown as WorkflowNode)).toBe(25)
    expect(parseMaxIterations({ maxIterations: -1 } as unknown as WorkflowNode)).toBe(10)
  })
})

describe('wrapper-fanout NodeKindHandler', () => {
  test('readyCondition: hasShards true → ready', () => {
    const ctx: WrapperFanoutReadyContext = {
      scope: baseScope,
      events: [],
      upstreamSummary: [],
      node: {} as WorkflowNode,
      hasShards: () => true,
    }
    expect(wrapperFanoutNodeKindHandler.readyCondition!(ctx)).toBe(true)
  })

  test('readyCondition: hasShards false → not ready', () => {
    const ctx: WrapperFanoutReadyContext = {
      scope: baseScope,
      events: [],
      upstreamSummary: [],
      node: {} as WorkflowNode,
      hasShards: () => false,
    }
    expect(wrapperFanoutNodeKindHandler.readyCondition!(ctx)).toBe(false)
  })

  test('dispatch: shards → enter-inner-scope-multi (sorted, deduped)', async () => {
    const node = { id: 'wf', kind: 'wrapper-fanout' } as unknown as WorkflowNode
    const ctx: WrapperFanoutDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      resolveShards: async () => ['c.ts', 'a.ts', 'a.ts', 'b.ts'],
    }
    const r = await wrapperFanoutNodeKindHandler.dispatch(ctx)
    if (r.kind !== 'enter-inner-scope-multi') throw new Error('expected enter-inner-scope-multi')
    expect(r.innerScopes.map((s) => s.shardKey)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(r.innerScopes.every((s) => s.iter === 0)).toBe(true)
  })

  test('dispatch: empty shard list → fail-direct', async () => {
    const node = { id: 'wf', kind: 'wrapper-fanout' } as unknown as WorkflowNode
    const ctx: WrapperFanoutDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      resolveShards: async () => [],
    }
    const r = await wrapperFanoutNodeKindHandler.dispatch(ctx)
    expect(r.kind).toBe('fail-direct')
  })

  test('onInnerScopeCompleted: not all shards done → request-retry-auto (waiting-shards)', async () => {
    const shardA: Scope = { ...baseScope, shardKey: 'a' }
    const shardB: Scope = { ...baseScope, shardKey: 'b' }
    const ctx: WrapperFanoutInnerCompletedContext = {
      scope: baseScope,
      innerScope: shardA,
      events: [],
      allShardScopes: [shardA, shardB],
      isShardComplete: async (s) => s.shardKey === 'a',
      aggregateShardOutputs: async () => ({}),
    }
    const r = await wrapperFanoutNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('request-retry-auto')
    if (r.kind === 'request-retry-auto') {
      expect(r.reason).toBe('fanout-waiting-shards')
    }
  })

  test('onInnerScopeCompleted: all shards done → done with aggregated outputs', async () => {
    const shardA: Scope = { ...baseScope, shardKey: 'a' }
    const shardB: Scope = { ...baseScope, shardKey: 'b' }
    const ctx: WrapperFanoutInnerCompletedContext = {
      scope: baseScope,
      innerScope: shardA,
      events: [],
      allShardScopes: [shardA, shardB],
      isShardComplete: async () => true,
      aggregateShardOutputs: async () => ({ summary: 'all done' }),
    }
    const r = await wrapperFanoutNodeKindHandler.onInnerScopeCompleted!(ctx)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      expect(r.outputs).toEqual({ summary: 'all done' })
    }
  })
})

// Silence unused-import warnings on Event from imports above.
const _unused: Event[] = []
void _unused

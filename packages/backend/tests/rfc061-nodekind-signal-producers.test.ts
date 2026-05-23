// RFC-061 PR-B — unit tests for review / clarify / clarify-cross-agent
// NodeKindHandlers. These NodeKinds are the "signal producers": they
// translate graph-level structural input into a suspend-direct
// DispatchResult that the taskActor turns into a suspension via the
// matching SignalKindHandler.

import { describe, expect, test } from 'bun:test'

import { reviewNodeKindHandler, type ReviewDispatchContext } from '../src/handlers/nodeKind/review'
import { clarifyNodeKindHandler } from '../src/handlers/nodeKind/clarify'
import {
  clarifyCrossAgentNodeKindHandler,
  type ClarifyCrossAgentDispatchContext,
} from '../src/handlers/nodeKind/clarifyCrossAgent'
import type { WorkflowNode, Scope, Event } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'rv', loopIter: 0, shardKey: '', iter: 0 }
const basePromptCtx = { selfClarifyQA: '', externalFeedback: '', reviewComments: '' }

describe('review NodeKindHandler', () => {
  test('dispatch: doc available → suspend-direct(review)', async () => {
    const node = {
      id: 'rv',
      kind: 'review',
      reviewerHint: 'check syntax',
    } as unknown as WorkflowNode
    const ctx: ReviewDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      readDocContent: async () => ({
        nodeId: 'designer',
        portName: 'draft',
        content: 'doc body',
      }),
    }
    const r = await reviewNodeKindHandler.dispatch(ctx)
    expect(r.kind).toBe('suspend-direct')
    if (r.kind === 'suspend-direct') {
      expect(r.signalKind).toBe('review')
      expect(r.awaitsActor).toBe('user:')
      const body = r.payload as { docContent: string; reviewerHint?: string }
      expect(body.docContent).toBe('doc body')
      expect(body.reviewerHint).toBe('check syntax')
    }
  })

  test('dispatch: doc not ready → noop with explicit reason', async () => {
    const node = { id: 'rv', kind: 'review' } as unknown as WorkflowNode
    const ctx: ReviewDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      readDocContent: async () => null,
    }
    const r = await reviewNodeKindHandler.dispatch(ctx)
    expect(r.kind).toBe('noop')
    if (r.kind === 'noop') {
      expect(r.reason).toContain('not ready')
    }
  })

  test('dispatch: no reviewerHint omits the field', async () => {
    const node = { id: 'rv', kind: 'review' } as unknown as WorkflowNode
    const ctx: ReviewDispatchContext = {
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
      node,
      readDocContent: async () => ({
        nodeId: 'd',
        portName: 'p',
        content: 'x',
      }),
    }
    const r = await reviewNodeKindHandler.dispatch(ctx)
    if (r.kind !== 'suspend-direct') throw new Error('expected suspend-direct')
    const body = r.payload as { reviewerHint?: string }
    expect(body.reviewerHint).toBeUndefined()
  })

  test('onAttemptFinished throws', async () => {
    await expect(
      reviewNodeKindHandler.onAttemptFinished(
        { scope: baseScope, attemptId: 'a', events: [] },
        { kind: 'success' },
      ),
    ).rejects.toThrow('has no direct attempts')
  })
})

describe('clarify NodeKindHandler', () => {
  test('dispatch → virtual-done with empty outputs', async () => {
    const r = await clarifyNodeKindHandler.dispatch({
      scope: baseScope,
      events: [],
      prompt: basePromptCtx,
    })
    expect(r.kind).toBe('virtual-done')
    if (r.kind === 'virtual-done') {
      expect(r.outputs).toEqual({})
    }
  })

  test('onAttemptFinished throws', async () => {
    await expect(
      clarifyNodeKindHandler.onAttemptFinished(
        { scope: baseScope, attemptId: 'a', events: [] },
        { kind: 'success' },
      ),
    ).rejects.toThrow('has no direct attempts')
  })
})

describe('clarify-cross-agent NodeKindHandler', () => {
  function ctx(
    opts: {
      hasQuestioner?: boolean
      hasPersistentStop?: boolean
      events?: ReadonlyArray<Event>
    } = {},
  ): ClarifyCrossAgentDispatchContext {
    return {
      scope: baseScope,
      events: opts.events ?? [],
      prompt: basePromptCtx,
      node: { id: 'cca', kind: 'clarify-cross-agent' } as unknown as WorkflowNode,
      hasQuestioner: () => opts.hasQuestioner ?? true,
      hasPersistentStop: () => opts.hasPersistentStop ?? false,
    }
  }

  test('no questioner wired → fail-direct', async () => {
    const r = await clarifyCrossAgentNodeKindHandler.dispatch(ctx({ hasQuestioner: false }))
    expect(r.kind).toBe('fail-direct')
  })

  test('persistent stop → virtual-done', async () => {
    const r = await clarifyCrossAgentNodeKindHandler.dispatch(
      ctx({ hasQuestioner: true, hasPersistentStop: true }),
    )
    expect(r.kind).toBe('virtual-done')
  })

  test('common path → virtual-done (suspension minted elsewhere by questioner)', async () => {
    const r = await clarifyCrossAgentNodeKindHandler.dispatch(ctx())
    expect(r.kind).toBe('virtual-done')
  })

  test('onAttemptFinished throws', async () => {
    await expect(
      clarifyCrossAgentNodeKindHandler.onAttemptFinished(
        { scope: baseScope, attemptId: 'a', events: [] },
        { kind: 'success' },
      ),
    ).rejects.toThrow('has no direct attempts')
  })
})

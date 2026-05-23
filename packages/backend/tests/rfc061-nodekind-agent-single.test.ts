// RFC-061 PR-B — unit tests for agent-single NodeKindHandler.
//
// Locks the dispatch + attempt-finished contracts spelled out in
// design/RFC-061-execution-event-sourced/design.md §5 + §11.
// composePrompt is tested directly to nail down the template substitution
// rules so prompt rendering stays stable across refactors.

import { describe, expect, test } from 'bun:test'

import {
  agentSingleNodeKindHandler,
  composePrompt,
  type AgentSingleDispatchContext,
} from '../src/handlers/nodeKind/agentSingle'
import type { WorkflowNode, Scope, Event } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'designer', loopIter: 0, shardKey: '', iter: 0 }

const baseDispatchCtx = {
  scope: baseScope,
  events: [] as ReadonlyArray<Event>,
  prompt: { selfClarifyQA: '', externalFeedback: '', reviewComments: '' },
}

describe('agent-single NodeKindHandler — dispatch', () => {
  test('returns spawn-attempt with composed prompt', async () => {
    const node = {
      id: 'designer',
      kind: 'agent-single',
      agentName: 'mAlice',
      promptTemplate: 'do {{idea}}',
    } as unknown as WorkflowNode
    const ctx: AgentSingleDispatchContext = {
      ...baseDispatchCtx,
      node,
      repoPath: '/repo',
      resolveUpstreamInputs: async () => [{ portName: 'idea', content: 'thing' }],
    }
    const result = await agentSingleNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('spawn-attempt')
    if (result.kind === 'spawn-attempt') {
      expect(result.prompt).toContain('do thing')
    }
  })

  test('missing agentName → fail-direct', async () => {
    const node = {
      id: 'designer',
      kind: 'agent-single',
      promptTemplate: 'x',
    } as unknown as WorkflowNode
    const ctx: AgentSingleDispatchContext = {
      ...baseDispatchCtx,
      node,
      repoPath: '/repo',
      resolveUpstreamInputs: async () => [],
    }
    const result = await agentSingleNodeKindHandler.dispatch(ctx)
    expect(result.kind).toBe('fail-direct')
  })

  test('empty promptTemplate yields empty body; signal context still appended', async () => {
    const node = {
      id: 'designer',
      kind: 'agent-single',
      agentName: 'mAlice',
    } as unknown as WorkflowNode
    const ctx: AgentSingleDispatchContext = {
      ...baseDispatchCtx,
      prompt: {
        selfClarifyQA: '<workflow-self-clarify>x</workflow-self-clarify>',
        externalFeedback: '',
        reviewComments: '',
      },
      node,
      repoPath: '/repo',
      resolveUpstreamInputs: async () => [],
    }
    const result = await agentSingleNodeKindHandler.dispatch(ctx)
    if (result.kind !== 'spawn-attempt') throw new Error('expected spawn-attempt')
    expect(result.prompt).toContain('<workflow-self-clarify>')
  })
})

describe('agent-single NodeKindHandler — onAttemptFinished', () => {
  const ctx = { scope: baseScope, attemptId: 'a1', events: [] as ReadonlyArray<Event> }

  test('success → done with empty outputs when no captures', async () => {
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(ctx, { kind: 'success' })
    expect(decision.kind).toBe('done')
    if (decision.kind === 'done') {
      expect(decision.outputs).toEqual({})
    }
  })

  test('success → done collects attempt-output-captured events for this attempt+scope', async () => {
    const events: Event[] = [
      {
        id: 'e1',
        taskId: 't1',
        ts: 1,
        kind: 'attempt-output-captured',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: 'a1',
        parentEventId: null,
        actor: 'system',
        resolutionId: null,
        payload: { portName: 'result', content: 'hello world' },
      },
      {
        id: 'e2',
        taskId: 't1',
        ts: 2,
        kind: 'attempt-output-captured',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: 'a-other',
        parentEventId: null,
        actor: 'system',
        resolutionId: null,
        payload: { portName: 'noise', content: 'ignored' },
      },
    ]
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(
      { ...ctx, events },
      { kind: 'success' },
    )
    if (decision.kind !== 'done') throw new Error('expected done')
    expect(decision.outputs).toEqual({ result: 'hello world' })
  })

  test('envelope-fail → request-retry-auto', async () => {
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(ctx, {
      kind: 'envelope-fail',
      reason: 'no closing tag',
    })
    expect(decision.kind).toBe('request-retry-auto')
    if (decision.kind === 'request-retry-auto') {
      expect(decision.reason).toContain('no closing tag')
    }
  })

  test('crash → request-retry-auto with exit code', async () => {
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(ctx, {
      kind: 'crash',
      exitCode: 137,
      errorMessage: 'OOM',
    })
    expect(decision.kind).toBe('request-retry-auto')
    if (decision.kind === 'request-retry-auto') {
      expect(decision.reason).toContain('137')
      expect(decision.reason).toContain('OOM')
    }
  })

  test('timeout → request-retry-auto', async () => {
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(ctx, {
      kind: 'timeout',
      timeoutMs: 60_000,
    })
    expect(decision.kind).toBe('request-retry-auto')
  })

  test('canceled → fail (cancel is unidirectional)', async () => {
    const decision = await agentSingleNodeKindHandler.onAttemptFinished(ctx, {
      kind: 'canceled',
      reason: 'user-cancel',
    })
    expect(decision.kind).toBe('fail')
  })
})

describe('composePrompt', () => {
  test('substitutes {{port_name}} with upstream content', () => {
    const r = composePrompt(
      'a={{x}} b={{y}}',
      [
        { portName: 'x', content: 'A' },
        { portName: 'y', content: 'B' },
      ],
      '/repo',
      { selfClarifyQA: '', externalFeedback: '', reviewComments: '' },
    )
    expect(r).toBe('a=A b=B')
  })

  test('substitutes {{__repo_path__}}', () => {
    const r = composePrompt('cd {{__repo_path__}}', [], '/var/repos/x', {
      selfClarifyQA: '',
      externalFeedback: '',
      reviewComments: '',
    })
    expect(r).toBe('cd /var/repos/x')
  })

  test('appends signal sections in deterministic order (self → external → review)', () => {
    const r = composePrompt('body', [], '/r', {
      selfClarifyQA: 'SC',
      externalFeedback: 'EF',
      reviewComments: 'RC',
    })
    expect(r).toBe('body\n\nSC\n\nEF\n\nRC')
  })

  test('skips empty signal sections', () => {
    const r = composePrompt('body', [], '/r', {
      selfClarifyQA: '',
      externalFeedback: 'EF',
      reviewComments: '',
    })
    expect(r).toBe('body\n\nEF')
  })

  test('preserves template when no upstreams + no signals + no repoPath token', () => {
    const r = composePrompt('static', [], '/r', {
      selfClarifyQA: '',
      externalFeedback: '',
      reviewComments: '',
    })
    expect(r).toBe('static')
  })
})

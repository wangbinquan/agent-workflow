// RFC-041 PR3 (RFC-061 follow-up) — agent-single dispatch appends the
// memory block when the loader closure is provided + non-null. Failures
// inside the loader degrade to "no inject" instead of crashing dispatch.

import { describe, expect, test } from 'bun:test'
import {
  agentSingleNodeKindHandler,
  type AgentSingleDispatchContext,
} from '../src/handlers/nodeKind/agentSingle'
import type { Scope } from '@agent-workflow/shared'

function buildBaseCtx(loadMemoryBlock?: () => Promise<string | null>): AgentSingleDispatchContext {
  const scope: Scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = {
    id: 'agent_a',
    kind: 'agent-single',
    agentName: 'coder',
    promptTemplate: 'Hello {{__repo_path__}}',
  }
  const ctx: AgentSingleDispatchContext = {
    scope,
    events: [],
    prompt: { selfClarifyQA: '', externalFeedback: '', reviewerFeedback: '' },
    node,
    repoPath: '/tmp/repo',
    resolveUpstreamInputs: async () => [],
    ...(loadMemoryBlock !== undefined ? { loadMemoryBlock } : {}),
  }
  return ctx
}

describe('agent-single dispatch — memory inject', () => {
  test('no loadMemoryBlock → prompt unchanged', async () => {
    const r = await agentSingleNodeKindHandler.dispatch(buildBaseCtx())
    expect(r.kind).toBe('spawn-attempt')
    if (r.kind !== 'spawn-attempt') throw new Error('unreachable')
    expect(r.prompt).toBe('Hello /tmp/repo')
  })

  test('loader returns block → block appended after \\n\\n separator', async () => {
    const block = '## Learned context (auto-injected, advisory)\n- [global] x'
    const r = await agentSingleNodeKindHandler.dispatch(buildBaseCtx(async () => block))
    if (r.kind !== 'spawn-attempt') throw new Error('unreachable')
    expect(r.prompt).toBe(`Hello /tmp/repo\n\n${block}`)
  })

  test('loader returns null → prompt unchanged', async () => {
    const r = await agentSingleNodeKindHandler.dispatch(buildBaseCtx(async () => null))
    if (r.kind !== 'spawn-attempt') throw new Error('unreachable')
    expect(r.prompt).toBe('Hello /tmp/repo')
  })

  test('loader returns empty string → no append (no trailing newlines)', async () => {
    const r = await agentSingleNodeKindHandler.dispatch(buildBaseCtx(async () => ''))
    if (r.kind !== 'spawn-attempt') throw new Error('unreachable')
    expect(r.prompt).toBe('Hello /tmp/repo')
  })

  test('loader throws → dispatch still succeeds with no inject', async () => {
    const r = await agentSingleNodeKindHandler.dispatch(
      buildBaseCtx(async () => {
        throw new Error('memories table broken')
      }),
    )
    if (r.kind !== 'spawn-attempt') throw new Error('unreachable')
    expect(r.prompt).toBe('Hello /tmp/repo')
  })
})

// RFC-046 — render contract for <InjectedMemoriesCard>.
//
// Locks:
//   - kind=non-agent (input / wrapper / review / clarify / output) → null.
//   - injectedMemories = null → "Inject record not captured".
//   - injectedMemories = []   → "No memories injected", title shows N=0.
//   - injectedMemories = [..] → grouped by scope, version + tags + preview.
//   - Long body collapses to 200-char ellipsis in preview; full body
//     surfaces inside the row's nested <details>.
//   - retry_index > 0 with same opencodeSessionId as attempt 0 → "Inherited
//     from attempt 0" chip.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { InjectedMemorySnapshot, NodeRun } from '@agent-workflow/shared'
import { InjectedMemoriesCard } from '../src/components/node-session/InjectedMemoriesCard'
import '../src/i18n'

function snap(overrides: Partial<InjectedMemorySnapshot> = {}): InjectedMemorySnapshot {
  return {
    id: 'mem_1',
    version: 2,
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'Prefer plural collection paths',
    bodyMd: 'Use /items not /item when generating list endpoints.',
    tags: ['api-naming'],
    sourceKind: 'review',
    approvedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function run(overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    seq: 0,
    id: 'r1',
    taskId: 't1',
    nodeId: 'n1',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...overrides,
  } as NodeRun
}

describe('<InjectedMemoriesCard>', () => {
  for (const kind of ['input', 'output', 'wrapper-git', 'wrapper-loop', 'review', 'clarify']) {
    test(`F1: kind=${kind} renders null (no card)`, () => {
      const r = run({ injectedMemories: [snap()] })
      const { container } = render(
        <InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind={kind} />,
      )
      expect(container.innerHTML).toBe('')
    })
  }

  test('F2: agent-single + null list shows "Not captured"', () => {
    const r = run({ injectedMemories: null })
    render(<InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />)
    expect(screen.getByText(/Injected memories \(—\)/)).toBeTruthy()
    expect(screen.getByText(/Inject record not captured/)).toBeTruthy()
  })

  test('F3: agent-single + empty list shows "No memories injected" + N=0', () => {
    const r = run({ injectedMemories: [] })
    render(<InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />)
    expect(screen.getByText(/Injected memories \(0\)/)).toBeTruthy()
    expect(screen.getByText(/No memories injected/)).toBeTruthy()
  })

  test('F4: snapshot list groups by scope, title shows N=count', () => {
    const list = [
      snap({ id: 'a1', scopeType: 'agent', scopeId: 'agent_x', title: 'Agent rule' }),
      snap({ id: 'w1', scopeType: 'workflow', scopeId: 'wf_a', title: 'Workflow rule' }),
      snap({ id: 'g1', scopeType: 'global', scopeId: null, title: 'Global rule' }),
    ]
    const r = run({ injectedMemories: list })
    render(<InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />)
    expect(screen.getByText(/Injected memories \(3\)/)).toBeTruthy()
    expect(screen.getByText('Agent rule')).toBeTruthy()
    expect(screen.getByText('Workflow rule')).toBeTruthy()
    expect(screen.getByText('Global rule')).toBeTruthy()
    // The group titles live in the dedicated <h4> elements so they
    // disambiguate from row-level scope chips (which use the same i18n key
    // family but render inside summary chips).
    expect(screen.getAllByText('Agent scope').some((el) => el.tagName === 'H4')).toBe(true)
    expect(screen.getAllByText('Workflow scope').some((el) => el.tagName === 'H4')).toBe(true)
    expect(screen.getAllByText('Global').some((el) => el.tagName === 'H4')).toBe(true)
  })

  test('F5: body longer than 200 chars truncates the preview with ellipsis', () => {
    const longBody = 'X'.repeat(250)
    const r = run({ injectedMemories: [snap({ bodyMd: longBody })] })
    const { container } = render(
      <InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />,
    )
    const preview = container.querySelector('.injected-memory-row__preview')
    expect(preview?.textContent?.endsWith('…')).toBe(true)
    expect(preview?.textContent?.length).toBe(201)
    // Full body must be inside the row's <pre>
    const body = container.querySelector('.injected-memory-row__body')
    expect(body?.textContent).toBe(longBody)
  })

  test('F6: retry_index>0 with shared opencodeSessionId surfaces the inherited chip', () => {
    // RFC-074 PR-C: attempt 0 FAILED an envelope check (the only state that
    // spawns the envelope-followup a1) — so the generation anchor walk keeps a1
    // in attempt-0's generation and the "inherited from attempt 0" chip shows.
    const a0 = run({
      id: 'r0',
      retryIndex: 0,
      status: 'failed',
      opencodeSessionId: 'sess_abc',
      injectedMemories: [snap()],
    })
    const a1 = run({
      id: 'r1',
      retryIndex: 1,
      opencodeSessionId: 'sess_abc',
      injectedMemories: [snap()],
    })
    render(<InjectedMemoriesCard run={a1} attempts={[a0, a1]} workflowNodeKind="agent-single" />)
    expect(screen.getByText(/Inherited from attempt 0/)).toBeTruthy()
  })

  test('F7: retry_index>0 with different opencodeSessionId does NOT show inherited chip', () => {
    // a0 failed (real followup predecessor) so a1 genuinely anchors to a0 and
    // the chip is suppressed by the SESSION mismatch, not a self-anchor.
    const a0 = run({
      id: 'r0',
      retryIndex: 0,
      status: 'failed',
      opencodeSessionId: 's0',
      injectedMemories: [snap()],
    })
    const a1 = run({ id: 'r1', retryIndex: 1, opencodeSessionId: 's1', injectedMemories: [snap()] })
    render(<InjectedMemoriesCard run={a1} attempts={[a0, a1]} workflowNodeKind="agent-single" />)
    expect(screen.queryByText(/Inherited from attempt 0/)).toBeNull()
  })

  test('F8: tags + version chip render on each row', () => {
    const r = run({ injectedMemories: [snap({ tags: ['x', 'y'], version: 7 })] })
    render(<InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />)
    expect(screen.getByText('x')).toBeTruthy()
    expect(screen.getByText('y')).toBeTruthy()
    expect(screen.getByText('v7')).toBeTruthy()
  })

  test('F9: undefined injectedMemories is treated as null (back-compat)', () => {
    const r = run({})
    delete (r as Record<string, unknown>).injectedMemories
    render(<InjectedMemoriesCard run={r} attempts={[r]} workflowNodeKind="agent-single" />)
    expect(screen.getByText(/Inject record not captured/)).toBeTruthy()
  })
})

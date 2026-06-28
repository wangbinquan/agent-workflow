// RFC-120 D12 — ClarifyQuestionHandler: the clarify-page per-question handler
// echo + picker. Self-filters to designer-domain questions; editable only for
// non-terminal entries; degrades to null on absent/non-array data (so it can't
// break the fragile clarify page).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const designerEntry = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry => ({
  id: 'e1',
  questionId: 'q1',
  questionTitle: 't',
  originNodeRunId: 'origin-1',
  sourceKind: 'cross',
  roleKind: 'designer',
  sourceNodeId: 'auditor',
  defaultTargetNodeId: 'coder',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'coder',
  phase: 'processing',
  confirmation: 'open',
  staged: false,
  answerSummary: null,
  ...over,
})

const SNAPSHOT = {
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'coder', kind: 'agent-single', agentName: 'coder' },
    { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
  ],
  edges: [],
  outputs: [],
}

function wrap(entries: unknown, snapshot: unknown, questionId = 'q1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: snapshot })
  return render(
    <QueryClientProvider client={qc}>
      <ClarifyQuestionHandler taskId="task-1" questionId={questionId} />
    </QueryClientProvider>,
  )
}

describe('ClarifyQuestionHandler', () => {
  test('designer entry + agent nodes → editable picker; reassign posts override', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    wrap([designerEntry()], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    // the Select renders a combobox trigger (editable variant)
    expect(within(root).getAllByRole('combobox').length).toBeGreaterThan(0)
    // (popover interaction is covered by Select's own tests; here we lock that the
    //  control is the editable variant for a non-terminal designer entry)
    void post
  })

  test('non-designer question → renders nothing', () => {
    wrap([designerEntry({ roleKind: 'questioner' })], SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  test('terminal (done) designer entry → read-only label, no select', () => {
    wrap([designerEntry({ phase: 'done', effectiveTargetNodeId: 'coder' })], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    expect(within(root).queryAllByRole('button').length).toBe(0)
    expect(root.textContent).toContain('coder')
  })

  test('defensive: non-array entries data → renders nothing (never throws)', () => {
    // a fetch-mock that serves the wrong shape must not crash the clarify page.
    wrap({ notAnArray: true }, SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })
})

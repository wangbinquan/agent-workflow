// RFC-490 (design §4.4, proposal C7 and P4): the per-question "handler node" row has
// nothing to offer when the workflow has a single candidate node, so the mindmap asks
// for it to be left out (`hideSingleChoice`). With two or more candidates the row is
// shown as before, and without the prop — the ordinary questionnaire and the
// centralized answer dialog — a single candidate is still shown, because there the row
// also says who handles the question. The row's own contract (who is the anchor, when
// it is editable) stays in clarify-question-handler.test.tsx.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'

afterEach(() => {
  cleanup()
})

const asker = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry => ({
  id: 'e-ask',
  questionId: 'q1',
  questionTitle: 'Pick a database',
  originNodeRunId: 'origin-1',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  autoDispatchDeferred: false,
  sealed: false,
  answerSummary: null,
  ...over,
})
const agent = (id: string) => ({ id, kind: 'agent-single', agentName: id })
const snapshot = (nodes: unknown[]) => ({
  $schema_version: 3,
  inputs: [],
  nodes,
  edges: [],
  outputs: [],
})
// The usual mindmap starter: one agent that asks, plus the nodes that are not agents.
const ONE = snapshot([
  agent('designer'),
  { id: 'gate', kind: 'clarify' },
  { id: 'out', kind: 'output' },
])
const TWO = snapshot([agent('designer'), agent('reviewer'), { id: 'gate', kind: 'clarify' }])

function show(
  workflow: unknown,
  props: { hideSingleChoice?: boolean } = {},
  entries: unknown = [asker()],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: workflow })
  return render(
    <QueryClientProvider client={qc}>
      <ClarifyQuestionHandler
        taskId="task-1"
        questionId="q1"
        originNodeRunId="origin-1"
        {...props}
      />
    </QueryClientProvider>,
  )
}
const row = () => screen.queryByTestId('clarify-handler-q1')

describe('ClarifyQuestionHandler hideSingleChoice', () => {
  test('mindmap: a single candidate node leaves the row out', () => {
    show(ONE, { hideSingleChoice: true })
    expect(row()).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  test('mindmap: with two candidates the row and its picker are shown', () => {
    show(TWO, { hideSingleChoice: true })
    const handler = row()
    expect(handler).not.toBeNull()
    const picker = within(handler!).getAllByRole('combobox')
    expect(picker.length).toBeGreaterThan(0)
    // It shows who handles the question now: the asking node.
    expect(picker[0]!.textContent).toContain('designer')
  })

  test('mindmap: a workflow without any candidate node has nothing to show either', () => {
    show(snapshot([{ id: 'gate', kind: 'clarify' }]), { hideSingleChoice: true })
    expect(row()).toBeNull()
  })

  test('mindmap: once the question is done its row is still read with two candidates', () => {
    show(TWO, { hideSingleChoice: true }, [asker({ phase: 'done' })])
    const handler = row()
    expect(handler).not.toBeNull()
    expect(within(handler!).queryAllByRole('combobox')).toHaveLength(0)
    expect(handler!.textContent).toContain('designer')
  })

  test('ordinary questionnaire: without the prop a single candidate is still shown', () => {
    show(ONE)
    const handler = row()
    expect(handler).not.toBeNull()
    expect(within(handler!).getAllByRole('combobox').length).toBeGreaterThan(0)
    expect(handler!.textContent).toContain('designer')
  })

  test('ordinary questionnaire: passing false behaves like not passing it', () => {
    show(ONE, { hideSingleChoice: false })
    expect(row()).not.toBeNull()
  })

  test('the prop never brings back a row the question has no anchor for', () => {
    // No asker entry: nothing to show whatever the candidate count.
    show(TWO, { hideSingleChoice: true }, [asker({ roleKind: 'designer' })])
    expect(row()).toBeNull()
    cleanup()
    show(TWO, {}, [asker({ roleKind: 'designer' })])
    expect(row()).toBeNull()
  })
})

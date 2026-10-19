import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
} from '@agent-workflow/shared'
import {
  DecisionDetails,
  DecisionReadback,
} from '../src/components/clarify/mindmap/DecisionDetails'
import { DecisionReviewDialog } from '../src/components/clarify/mindmap/DecisionReviewDialog'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import {
  compressMindmapCategories,
  projectClarifyMindmap,
} from '../src/lib/clarify/mindmap/projection'
import { mindmapFollowupLimit, composeMindmapFollowup } from '../src/lib/clarify/mindmap/followup'
import { createClarifyDraftDurabilityController } from '../src/lib/clarify/durability'
import { answersEqual } from '../src/lib/clarify/answers'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: ({ onSelect }: { onSelect(id: string): void }) => (
    <button onClick={() => onSelect('q:q')}>Select question</button>
  ),
}))
const q = ClarifyQuestionSchema.parse({
  id: 'q',
  title: 'Booking limits?',
  kind: 'single',
  options: ['Observe first', 'Limit now'],
  mindmap: { categoryPath: ['Rooms', 'Policy', 'Limits'] },
})
const base: ClarifyAnswer = {
  questionId: 'q',
  selectedOptionIndices: [0],
  selectedOptionLabels: ['stale label'],
  customText: '',
}
const answer: ClarifyAnswer = {
  ...base,
  decision: {
    status: 'provisional',
    uncertainty: 'No baseline',
    tradeoff: 'Some conflicts remain',
  },
}

test('projection reads actual option labels and keeps maturity separate from confirmation', () => {
  const nodes = projectClarifyMindmap(
    [q],
    { q: { ...answer, confirmedBasis: clarifyAnswerBasis(q, answer) } },
    new Set(),
    'Business title',
  )
  expect(nodes.at(-1)).toMatchObject({
    status: 'done',
    decisionStatus: 'provisional',
    answerSummary: 'Observe first',
  })
  expect(nodes[0]?.title).toBe('Business title')
  const compact = compressMindmapCategories(nodes)
  expect(compact).toHaveLength(3)
  expect(compact[1]?.title).toBe('Rooms / Policy / Limits')
  expect(compact[1]?.id).toBe('g:["Rooms","Policy","Limits"]')
  expect(nodes).toHaveLength(5)
  expect(compact[0]?.counts).toEqual(nodes[0]?.counts)
  expect(
    compressMindmapCategories(nodes, new Set(['g:["Rooms"]'])).some(
      (node) => node.id === 'g:["Rooms"]',
    ),
  ).toBe(true)
})

test('decision edits invalidate confirmation and decided keeps unknowns and review fields editable', () => {
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState<ClarifyAnswer>({
      ...answer,
      confirmedBasis: clarifyAnswerBasis(q, answer),
    })
    return (
      <DecisionDetails
        answer={value}
        disabled={false}
        onChange={(next) => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByText(/Decision context/))
  fireEvent.click(screen.getByRole('radio', { name: 'Decided' }))
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    decision: { status: 'decided', uncertainty: 'No baseline' },
    confirmedBasis: undefined,
  })
  fireEvent.change(screen.getByLabelText('Who will validate'), { target: { value: 'Lin' } })
  expect(changed.mock.lastCall?.[0].decision.validationOwner).toBe('Lin')
  expect(screen.getByLabelText('Still unverified')).toBeTruthy()
})

test('review shows latest original answers and unknowns for decided items, with locate and blocking', () => {
  const edit = vi.fn(),
    submit = vi.fn()
  const props = {
    open: true,
    title: 'Rooms',
    questions: [q],
    answers: { q: answer },
    locked: new Set<string>(),
    directive: 'stop' as const,
    onDirective: vi.fn(),
    onClose: vi.fn(),
    onEdit: edit,
    onSubmit: submit,
    disabled: true,
    busy: false,
    blockReason: 'Save failed',
    followupFailed: true,
    error: null,
    isCross: false,
  }
  const view = render(<DecisionReviewDialog {...props} />)
  expect(screen.getByText('No baseline')).toBeTruthy()
  expect(screen.getByText(/ownership or review timing is still unspecified/)).toBeTruthy()
  expect(screen.getByTestId('mindmap-review-submit').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Locate / edit' }))
  expect(edit).toHaveBeenCalledWith('q')
  const updated: ClarifyAnswer = {
    ...answer,
    customText: 'My changed answer',
    selectedOptionIndices: [],
    decision: {
      status: 'decided',
      uncertainty: 'Still unverified',
      validationOwner: 'Lin',
      revisitWhen: 'Next Friday',
    },
  }
  view.rerender(<DecisionReviewDialog {...props} disabled={false} answers={{ q: updated }} />)
  expect(screen.getByText('My changed answer')).toBeTruthy()
  expect(screen.getByText('Next Friday')).toBeTruthy()
  expect(screen.queryByText('No baseline')).toBeNull()
  fireEvent.click(screen.getByTestId('mindmap-review-submit'))
  expect(submit).toHaveBeenCalledTimes(1)
})

test('unmarked notes remain unmarked; no extra maturity is inferred', () => {
  render(<DecisionReadback decision={{ rationale: 'Observation only' }} />)
  expect(screen.getByText('Unmarked')).toBeTruthy()
  expect(screen.queryByText('Provisional')).toBeNull()
})

test('quote budget includes wrapper and instruction; nothing is silently cut', () => {
  expect(mindmapFollowupLimit('x'.repeat(501), '')).toBe('quote')
  expect(mindmapFollowupLimit('x'.repeat(500), 'x'.repeat(1490))).toBe('instruction')
  expect(composeMindmapFollowup('原话', '请检查依据')).toContain('原话')
  expect(mindmapFollowupLimit('原话', '请检查依据')).toBeNull()
})

test('specific prompts stay editable and failed follow-up retries the same branch and instruction', async () => {
  const followup = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined)
  render(
    <MindmapWorkspace
      title="Rooms"
      questions={[q]}
      answers={{ q: answer }}
      locked={new Set()}
      disabled={false}
      followupPending={false}
      onChange={vi.fn()}
      onFollowup={followup}
      onCancelFollowup={async () => {}}
      renderQuestion={() => <p>Original wording</p>}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Select question' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check the evidence' }))
  expect(followup).not.toHaveBeenCalled()
  const instruction = screen.getByLabelText('What needs more detail? (optional)')
  fireEvent.change(instruction, { target: { value: 'Check the missing baseline' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }))
  })
  expect(followup).toHaveBeenLastCalledWith('q', 'Check the missing baseline')
  expect(screen.getByDisplayValue('Check the missing baseline')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry follow-up' }))
  })
  expect(followup).toHaveBeenCalledTimes(2)
  expect(followup).toHaveBeenLastCalledWith('q', 'Check the missing baseline')
})

test('durable snapshots deep copy decisions and remote decision-only changes are adopted', async () => {
  const local: ClarifyAnswer[][] = [],
    server: ClarifyAnswer[] = []
  const controller = createClarifyDraftDurabilityController({
    initialAnswers: [base],
    serverAnswers: [base],
    debounceMs: 0,
    writeLocal: async ({ answers }) => {
      local.push(answers)
    },
    writeServer: async ({ answer }) => {
      server.push(answer)
    },
  })
  const edited = { ...base, decision: { rationale: 'First rationale' } }
  controller.recordChange([edited], 'q')
  edited.decision.rationale = 'Mutation after enqueue'
  await controller.flushLocal()
  await controller.flushServer()
  expect(local.at(-1)?.[0]?.decision?.rationale).toBe('First rationale')
  expect(server.at(-1)?.decision?.rationale).toBe('First rationale')
  const persisted = server.at(-1)!
  const remote = { ...persisted, decision: { uncertainty: 'A collaborator changed this' } }
  expect(answersEqual(persisted, remote)).toBe(false)
  expect(controller.tryAdoptRemote('q', persisted, remote)).toBe(true)
  await controller.flushLocal()
  expect(local.at(-1)?.[0]?.decision?.uncertainty).toBe('A collaborator changed this')
  await controller.seal()
})

test('a real DOM selection becomes a removable quote on the same follow-up target', async () => {
  const followup = vi.fn(async () => {})
  render(
    <MindmapWorkspace
      title="Rooms"
      questions={[q]}
      answers={{ q: answer }}
      locked={new Set()}
      disabled={false}
      followupPending={false}
      onChange={vi.fn()}
      onFollowup={followup}
      onCancelFollowup={async () => {}}
      renderQuestion={() => <p>Original selected wording</p>}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Select question' }))
  const range = document.createRange()
  range.selectNodeContents(screen.getByText('Original selected wording'))
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this passage' }))
  expect(screen.getByRole('button', { name: 'Remove quote' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('What needs more detail? (optional)'), {
    target: { value: 'What supports this?' },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }))
  })
  expect(followup).toHaveBeenCalledWith(
    'q',
    composeMindmapFollowup('Original selected wording', 'What supports this?'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }))
  expect(screen.queryByRole('button', { name: 'Remove quote' })).toBeNull()
})

test('refresh restores the failed request quote and direction; a legacy failure asks for review before retry', async () => {
  const followup = vi.fn(async () => {})
  const props = {
    title: 'Rooms',
    questions: [q],
    answers: { q: answer },
    locked: new Set<string>(),
    disabled: false,
    followupPending: false,
    onChange: vi.fn(),
    onFollowup: followup,
    onCancelFollowup: async () => {},
    renderQuestion: () => <p>Question body</p>,
  }
  const original = composeMindmapFollowup('Quoted evidence', 'Check its source')
  const view = render(
    <MindmapWorkspace
      {...props}
      followupFailure={{ target: 'q', instruction: original, error: new Error('failed') }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Select question' }))
  expect(
    screen
      .getByText(/The follow-up did not finish\. Existing answers are kept/)
      .getAttribute('role'),
  ).toBe('alert')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry follow-up' }))
  })
  expect(followup).toHaveBeenLastCalledWith('q', original)
  view.unmount()
  followup.mockClear()
  render(
    <MindmapWorkspace
      {...props}
      followupFailure={{ target: 'q', error: new Error('legacy failure') }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Select question' }))
  expect(screen.queryByRole('button', { name: 'Retry follow-up' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review follow-up direction' }))
  expect(followup).not.toHaveBeenCalled()
  expect(screen.getByLabelText('What needs more detail? (optional)')).toBeTruthy()
})

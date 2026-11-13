// RFC-490 (design §6.7, proposal C6): the review dialog reads by category and puts
// what needs a second look up front. A summary line counts each state, a filter
// narrows the list to the entries that need attention, entries are grouped by the
// category path of their root question with follow-ups nested under it, and the submit
// choice stays in a sticky area at the bottom of the scrolling list. A sealed round
// reads the same dialog without that area. Locating a question still works from every
// entry. The counting and grouping themselves are in rfc490-mindmap-guidance.test.ts;
// here it is what the dialog shows and does with them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { DecisionReviewDialog } from '../src/components/clarify/mindmap/DecisionReviewDialog'

const ask = (id: string, categoryPath: string[], parentQuestionId?: string): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    id,
    title: `Question ${id}`,
    kind: 'single',
    options: ['Streaming replica', 'Nightly backup'],
    mindmap: { categoryPath, ...(parentQuestionId ? { parentQuestionId } : {}) },
  })
const answer = (
  target: ClarifyQuestion,
  patch: Partial<ClarifyAnswer> = {},
  confirm = true,
): ClarifyAnswer => {
  const value: ClarifyAnswer = {
    questionId: target.id,
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
    ...patch,
  }
  return confirm ? { ...value, confirmedBasis: clarifyAnswerBasis(target, value) } : value
}

const database = ['Performance', 'Database']
const p1 = ask('p1', database)
const r1 = ask('r1', ['Reliability'])
const p1a = ask('p1a', database, 'p1')
const p2 = ask('p2', database)
// Round order, which is what "Qn" follows: p1 = Q1, r1 = Q2, p1a = Q3, p2 = Q4.
const questions = [p1, r1, p1a, p2]
const answers: Record<string, ClarifyAnswer> = {
  // Decided, with a reason, confirmed: nothing to look at again.
  p1: answer(p1, { decision: { status: 'decided', rationale: 'Measured last quarter' } }),
  // Provisional: always worth a second look.
  p1a: answer(p1a, { decision: { status: 'provisional', rationale: 'A guess for now' } }),
  // Skipped and confirmed, with the reason it does not apply.
  r1: answer(r1, {
    selectedOptionIndices: [],
    decision: { status: 'not-applicable', rationale: 'Single region only' },
  }),
  // Answered, unmarked, no reason, not confirmed yet.
  p2: answer(p2, { selectedOptionIndices: [1] }, false),
}

const base = {
  open: true,
  title: 'Report service',
  questions,
  answers,
  locked: new Set<string>(),
  directive: 'stop' as const,
  onDirective: () => {},
  onClose: () => {},
  onEdit: () => {},
  onSubmit: () => {},
  disabled: false,
  busy: false,
  followupFailed: false,
  error: null,
  isCross: false,
}
const titles = () =>
  screen.queryAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)
const filter = () => screen.getByRole('radiogroup', { name: 'Show' })

test('the summary line counts each state once and leaves out the ones that do not occur', () => {
  render(<DecisionReviewDialog {...base} />)
  const summary = screen.getByTestId('mindmap-review-summary')
  expect(summary.firstElementChild?.textContent).toBe('4 questions')
  expect(summary.firstElementChild?.hasAttribute('data-review-count')).toBe(false)
  expect(
    Array.from(summary.querySelectorAll('[data-review-count]'), (item) => [
      item.getAttribute('data-review-count'),
      item.textContent,
    ]),
  ).toEqual([
    ['confirmed', '3 confirmed'],
    ['provisional', '1 provisional'],
    ['unmarked', '1 unmarked'],
    ['notApplicable', '1 not applicable'],
    // Nothing was deferred, so "deferred" is not mentioned at all.
    ['noRationale', '1 without rationale'],
  ])
  // The attention count is the filter's, not a seventh summary item.
  expect(within(filter()).getByRole('radio', { name: 'Needs attention (2)' })).toBeTruthy()
})

test('the summary follows the answers as they change', () => {
  const view = render(<DecisionReviewDialog {...base} />)
  view.rerender(
    <DecisionReviewDialog
      {...base}
      answers={{
        ...answers,
        p1a: answer(p1a, { selectedOptionIndices: [], decision: { status: 'deferred' } }),
        p2: answer(p2, {
          selectedOptionIndices: [1],
          decision: { status: 'decided', rationale: 'Cheapest that meets the target' },
        }),
      }}
    />,
  )
  const counts = Object.fromEntries(
    Array.from(
      screen.getByTestId('mindmap-review-summary').querySelectorAll('[data-review-count]'),
      (item) => [item.getAttribute('data-review-count'), item.textContent],
    ),
  )
  expect(counts).toEqual({
    confirmed: '4 confirmed',
    notApplicable: '1 not applicable',
    deferred: '1 deferred',
  })
  // A deferred question stays on the attention list even though it is confirmed.
  expect(within(filter()).getByRole('radio', { name: 'Needs attention (1)' })).toBeTruthy()
})

test('"needs attention" keeps only what is unconfirmed, provisional, deferred or unexplained', () => {
  render(<DecisionReviewDialog {...base} />)
  const all = within(filter()).getByRole('radio', { name: 'All' })
  const attention = within(filter()).getByRole('radio', { name: 'Needs attention (2)' })
  expect(all.getAttribute('aria-checked')).toBe('true')
  expect(titles()).toEqual([
    'Q1 · Question p1',
    'Q3 · Question p1a',
    'Q4 · Question p2',
    'Q2 · Question r1',
  ])
  fireEvent.click(attention)
  expect(attention.getAttribute('aria-checked')).toBe('true')
  expect(titles()).toEqual(['Q3 · Question p1a', 'Q4 · Question p2'])
  // A group with nothing left in it goes away with its entries.
  expect(screen.queryByRole('region', { name: 'Reliability' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Performance / Database' })).toBeTruthy()
  // The summary keeps describing the whole round.
  expect(screen.getByTestId('mindmap-review-summary').firstElementChild?.textContent).toBe(
    '4 questions',
  )
  fireEvent.click(all)
  expect(titles()).toHaveLength(4)
  expect(screen.getByRole('region', { name: 'Reliability' })).toBeTruthy()
})

test('with nothing to look at again the attention view says so', () => {
  render(
    <DecisionReviewDialog
      {...base}
      questions={[p1, r1]}
      answers={{ p1: answers.p1!, r1: answers.r1! }}
    />,
  )
  expect(screen.queryByText('Nothing needs attention.')).toBeNull()
  fireEvent.click(within(filter()).getByRole('radio', { name: 'Needs attention (0)' }))
  expect(screen.getByText('Nothing needs attention.')).toBeTruthy()
  expect(titles()).toEqual([])
  expect(screen.queryByRole('article')).toBeNull()
})

test('entries are grouped by category, in round order, with follow-ups nested under their question', () => {
  render(<DecisionReviewDialog {...base} />)
  const groups = Array.from(document.querySelectorAll('section.mindmap-review__group'))
  expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
    'Performance / Database',
    'Reliability',
  ])
  const group = screen.getByRole('region', { name: 'Performance / Database' })
  expect(within(group).getByRole('heading', { level: 4 }).textContent).toBe(
    'Performance / Database',
  )
  const items = within(group).getAllByRole('article')
  expect(items.map((item) => item.querySelector('h5')?.textContent)).toEqual([
    'Q1 · Question p1',
    'Q3 · Question p1a',
    'Q4 · Question p2',
  ])
  expect(items.every((item) => item.classList.contains('mindmap-review__item'))).toBe(true)
  // The follow-up sits one level in, right after the question it was asked from.
  expect(items.map((item) => item.getAttribute('data-depth'))).toEqual(['0', '1', '0'])
  expect(within(items[1]!).getByText('Follow-up to Q1')).toBeTruthy()
  expect(within(items[0]!).queryByText(/Follow-up to/)).toBeNull()
  expect(within(items[2]!).queryByText(/Follow-up to/)).toBeNull()
  const other = screen.getByRole('region', { name: 'Reliability' })
  expect(within(other).getAllByRole('article')).toHaveLength(1)
})

test('a long follow-up chain stays under its root and stops indenting after three levels', () => {
  const chain = Array.from({ length: 6 }, (_, index) =>
    ask(`d${index}`, ['Scope'], index ? `d${index - 1}` : undefined),
  )
  render(<DecisionReviewDialog {...base} questions={chain} answers={{}} />)
  const items = within(screen.getByRole('region', { name: 'Scope' })).getAllByRole('article')
  expect(items.map((item) => item.getAttribute('data-depth'))).toEqual([
    '0',
    '1',
    '2',
    '3',
    '3',
    '3',
  ])
  expect(items.map((item) => item.querySelector('h5')?.textContent)).toEqual(
    chain.map((question, index) => `Q${index + 1} · ${question.title}`),
  )
})

test('a skipped question reads as its skip, with the note under the skip’s own label', () => {
  render(<DecisionReviewDialog {...base} />)
  const [skipped] = within(screen.getByRole('region', { name: 'Reliability' })).getAllByRole(
    'article',
  )
  // No empty "answer" line: nothing was chosen, on purpose.
  expect(skipped!.querySelector('.mindmap-review__answer')).toBeNull()
  expect(within(skipped!).getByText('Confirmed')).toBeTruthy()
  expect(skipped!.querySelector('[data-decision-status="not-applicable"]')?.textContent).toBe(
    'Not applicable',
  )
  expect(within(skipped!).getByText('Why it does not apply')).toBeTruthy()
  expect(within(skipped!).getByText('Single region only')).toBeTruthy()
  expect(within(skipped!).queryByText('My rationale')).toBeNull()
  // An answered one still shows what was chosen.
  const [first] = within(
    screen.getByRole('region', { name: 'Performance / Database' }),
  ).getAllByRole('article')
  expect(first!.querySelector('.mindmap-review__answer')?.textContent).toBe('Streaming replica')
  expect(within(first!).getByText('My rationale')).toBeTruthy()
})

test('"locate" hands back the question of the entry it was pressed on, in either view', () => {
  const onEdit = vi.fn()
  render(<DecisionReviewDialog {...base} onEdit={onEdit} />)
  const entry = (title: string) =>
    screen.getByRole('heading', { level: 5, name: title }).closest('article')!
  fireEvent.click(within(entry('Q4 · Question p2')).getByRole('button', { name: 'Locate / edit' }))
  expect(onEdit).toHaveBeenLastCalledWith('p2')
  fireEvent.click(within(entry('Q2 · Question r1')).getByRole('button', { name: 'Locate / edit' }))
  expect(onEdit).toHaveBeenLastCalledWith('r1')
  fireEvent.click(within(filter()).getByRole('radio', { name: 'Needs attention (2)' }))
  fireEvent.click(within(entry('Q3 · Question p1a')).getByRole('button', { name: 'Locate / edit' }))
  expect(onEdit).toHaveBeenLastCalledWith('p1a')
  expect(onEdit).toHaveBeenCalledTimes(3)
})

test('the submit choice lives in one area after the list, which the stylesheet pins to the bottom', () => {
  const onDirective = vi.fn()
  render(
    <DecisionReviewDialog
      {...base}
      onDirective={onDirective}
      blockReason="Complete and confirm each unlocked answer first."
      followupFailed
    />,
  )
  const next = document.querySelector<HTMLElement>('.mindmap-review__next')!
  expect(next).not.toBeNull()
  const choice = within(next).getByRole('radiogroup', { name: 'After this submission' })
  expect(
    within(choice)
      .getAllByRole('radio')
      .map((radio) => radio.textContent),
  ).toEqual(['Generate a result from these decisions', 'Keep clarifying'])
  fireEvent.click(within(choice).getByRole('radio', { name: 'Keep clarifying' }))
  expect(onDirective).toHaveBeenCalledWith('continue')
  // What blocks the submission is said next to the choice, not somewhere up the list.
  expect(within(next).getByText('Complete and confirm each unlocked answer first.')).toBeTruthy()
  // It comes after every entry, inside the same scrolling body.
  const entries = screen.getAllByRole('article')
  expect(
    entries.at(-1)!.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(next.closest('.mindmap-review')).toBe(entries[0]!.closest('.mindmap-review'))
  // The failed follow-up notice belongs to the list, above the entries.
  expect(
    screen.getByText(/A follow-up did not complete/).closest('.mindmap-review__next'),
  ).toBeNull()
  // Layout cannot be measured here, so the rule itself is read from the stylesheet.
  const css = readFileSync(
    join(__dirname, '../src/components/clarify/mindmap/mindmap.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = css.match(/\.mindmap-review__next\s*\{([^}]*)\}/)?.[1] ?? ''
  expect(rule).toMatch(/position:\s*sticky/)
  expect(rule).toMatch(/bottom:\s*0/)
  expect(rule).toMatch(/background:\s*var\(--panel\)/)
})

test('a sealed round keeps the summary, the filter and the groups but has nothing to submit', () => {
  const onEdit = vi.fn()
  const onClose = vi.fn()
  render(
    <DecisionReviewDialog
      {...base}
      readonly
      disabled
      locked={new Set(questions.map((question) => question.id))}
      onEdit={onEdit}
      onClose={onClose}
      blockReason="All questions have been handled."
      followupFailed
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Decision summary for this round' })).toBeTruthy()
  expect(screen.getByText(/They are read-only\./)).toBeTruthy()
  // Everything is sealed, so everything counts as confirmed.
  expect(
    screen.getByTestId('mindmap-review-summary').querySelector('[data-review-count="confirmed"]')
      ?.textContent,
  ).toBe('4 confirmed')
  expect(titles()).toHaveLength(4)
  // Sealed or not, a provisional decision and one without a reason are worth a look.
  fireEvent.click(within(filter()).getByRole('radio', { name: 'Needs attention (2)' }))
  expect(titles()).toEqual(['Q3 · Question p1a', 'Q4 · Question p2'])
  // No submit area, no block reason, no retry advice: there is nothing left to do.
  expect(document.querySelector('.mindmap-review__next')).toBeNull()
  expect(screen.queryByRole('radiogroup', { name: 'After this submission' })).toBeNull()
  expect(screen.queryByText('All questions have been handled.')).toBeNull()
  expect(screen.queryByText(/A follow-up did not complete/)).toBeNull()
  expect(screen.queryByTestId('mindmap-review-submit')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Locate / edit' })).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Locate' })[1]!)
  expect(onEdit).toHaveBeenCalledWith('p2')
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(onClose).toHaveBeenCalledOnce()
})

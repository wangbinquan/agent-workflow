import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ClarifyQuestionSchema, type ClarifyAnswer } from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'

// Canvas handlers have their own actual-event tests. Keep workspace tests focused
// on one original controlled answer, view switches and inline confirmation.
vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: ({ onSelect }: { onSelect(id: string): void }) => (
    <button onClick={() => onSelect('q:a')}>Select canvas question</button>
  ),
}))
const question = ClarifyQuestionSchema.parse({
  id: 'a',
  title: 'Scope question',
  kind: 'single',
  options: ['A', 'B'],
  mindmap: { categoryPath: ['Scope'] },
})
const followup = vi.fn(async () => {})
function Harness() {
  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({
    a: { questionId: 'a', selectedOptionIndices: [], selectedOptionLabels: [], customText: '' },
  })
  return (
    <MindmapWorkspace
      title="Design"
      questions={[question]}
      answers={answers}
      locked={new Set()}
      disabled={false}
      followupPending={false}
      onChange={(id, value) => setAnswers({ ...answers, [id]: value })}
      onFollowup={followup}
      onCancelFollowup={async () => {}}
      renderQuestion={() => (
        <button onClick={() => setAnswers({ a: { ...answers.a!, selectedOptionIndices: [0] } })}>
          Answer original question
        </button>
      )}
    />
  )
}
describe('RFC-372 single workspace', () => {
  test('the same answer is confirmed in place and remains complete in focus and panorama', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas question' }))
    expect(
      screen
        .getByRole('button', { name: /Confirm this answer|确认这个回答/ })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Answer original question' }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm this answer|确认这个回答/ }))
    expect(screen.getByText(/This round is reviewed|本轮审阅完成/)).toBeTruthy()
    const view = screen.getByRole('radiogroup', { name: /View|视图/ })
    fireEvent.click(within(view).getByRole('radio', { name: /Focus|聚焦/ }))
    expect(
      screen.getByRole('button', { name: /^(Confirmed|已确认)$/ }).hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Answer original question' })).toHaveLength(1)
    fireEvent.click(within(view).getByRole('radio', { name: /Panorama|全景/ }))
    expect(screen.getByText(/This round is reviewed|本轮审阅完成/)).toBeTruthy()
    expect(screen.queryByText(/Zoom branch|放大此分支/)).toBeNull()
  })
})

test('category validation preserves the existing categories and guidance when a limit is exceeded', async () => {
  const { ClarifyModeEdit } = await import('../src/components/canvas/inspector/ClarifyModeEdit')
  const { WorkflowNodeSchema } = await import('@agent-workflow/shared')
  const patch = vi.fn()
  const node = WorkflowNodeSchema.parse({
    id: 'gate',
    kind: 'clarify',
    interactionMode: 'mindmap',
    mindmap: {
      categories: Array.from({ length: 40 }, (_, i) => `Category ${i}`),
      instructions: 'Keep my guidance',
    },
  })
  render(<ClarifyModeEdit node={node} onPatch={patch} onHistoryBoundary={() => {}} />)
  const input = screen.getByRole('textbox', { name: /Question categories|提问分类/ })
  fireEvent.change(input, { target: { value: 'Too many' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(patch).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('Keep my guidance')).toBeTruthy()
  expect(screen.getByText('Category 39')).toBeTruthy()
  fireEvent.change(input, { target: { value: 'x'.repeat(121) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(patch).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('Keep my guidance')).toBeTruthy()
})

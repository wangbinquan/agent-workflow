// RFC-372 review follow-up O8 (design/RFC-372-mindmap-clarify/review-followups-20261014.md §4.7).
//
// WHY THIS EXISTS: follow-ups now generate in the background once the daemon accepts
// them (202). The page must keep showing "generating" from the round's reported state —
// after the request returns, after a refresh and for the other members — cancel from
// that state, and show a background failure on its branch like a rejected request.
// Canceling is not a failure, so it is never shown as one.
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  type ClarifyFollowupStatus,
  type ClarifyFollowupTarget,
} from '@agent-workflow/shared'
import { api, ApiError } from '../src/api/client'
import type * as ClientModule from '../src/api/client'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { mindmapTargetNodeId } from '../src/lib/clarify/mindmap/projection'
import { useClarifyFollowup } from '../src/lib/clarify/useClarifyFollowup'

vi.mock('../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  api: { post: vi.fn(), delete: vi.fn() },
}))
vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: () => <div role="img" aria-label="Test map" />,
}))

const request = { parentQuestionId: 'q1', basis: 'basis', instruction: '' }
const running = (target: string | string[] = 'q1'): ClarifyFollowupStatus => ({
  requestId: 'server-request',
  state: 'running',
  target,
  startedAt: 1,
})
const failed = (code: string): ClarifyFollowupStatus => ({
  requestId: 'server-request',
  state: 'failed',
  target: 'q1',
  startedAt: 1,
  error: { code, message: `${code} message` },
})

test('an accepted request keeps the page generating from the round until it settles', async () => {
  vi.mocked(api.post).mockClear().mockResolvedValue({ state: 'running' })
  let status: ClarifyFollowupStatus | undefined
  // The refetched round reports the background generation.
  const refresh = vi.fn(async () => {
    status = running()
  })
  const { result, rerender } = renderHook(() => useClarifyFollowup('A', refresh, status))
  await act(async () => {
    await result.current.start(request, async () => {})
  })
  expect(refresh).toHaveBeenCalledWith('A')
  expect(result.current.pending).toBe(true)
  expect(result.current.running?.target).toBe('q1')
  // Another start while the round generates is ignored, not sent.
  await act(async () => {
    await result.current.start(request, async () => {})
  })
  expect(api.post).toHaveBeenCalledTimes(1)
  status = undefined
  rerender()
  expect(result.current.pending).toBe(false)
})

test('a refreshed page recovers the generation from the round and cancels it there', async () => {
  vi.mocked(api.delete).mockClear().mockResolvedValue(undefined)
  const refresh = vi.fn(async () => {})
  const { result } = renderHook(() => useClarifyFollowup('A', refresh, running(['Scope'])))
  expect(result.current.pending).toBe(true)
  expect(result.current.running?.target).toEqual(['Scope'])
  await act(async () => {
    await result.current.cancel()
  })
  expect(api.delete).toHaveBeenCalledWith('/api/clarify/A/followup/server-request')
  // The cached round still reports it until the refetch lands; this page canceled it.
  expect(result.current.pending).toBe(false)
  expect(refresh).toHaveBeenCalledWith('A')
})

test('a background failure surfaces with its code; a cancel does not', () => {
  const { result, rerender } = renderHook(
    ({ status }) => useClarifyFollowup('A', async () => {}, status),
    { initialProps: { status: failed('clarify-followup-invalid') } },
  )
  expect(result.current.pending).toBe(false)
  expect(result.current.failure?.target).toBe('q1')
  expect(result.current.failure?.error).toBeInstanceOf(ApiError)
  expect(result.current.failure?.error).toMatchObject({
    code: 'clarify-followup-invalid',
    message: 'clarify-followup-invalid message',
  })
  rerender({ status: failed('clarify-followup-canceled') })
  expect(result.current.failure).toBeUndefined()
})

test('follow-up targets name their mindmap nodes', () => {
  expect(mindmapTargetNodeId('q1')).toBe('q:q1')
  expect(mindmapTargetNodeId([])).toBe('root')
  expect(mindmapTargetNodeId(['Scope', 'Rules'])).toBe('g:["Scope","Rules"]')
})

const questions = [
  ClarifyQuestionSchema.parse({
    id: 'q1',
    title: 'Main decision',
    kind: 'single',
    options: ['A', 'B'],
    mindmap: { categoryPath: ['Scope'] },
  }),
]
function Workspace(props: {
  running?: ClarifyFollowupTarget
  failure?: { target: ClarifyFollowupTarget; error: unknown }
  pending?: boolean
  cancel?: () => Promise<void>
}) {
  return (
    <MindmapWorkspace
      title="Room booking"
      questions={questions}
      answers={{}}
      locked={new Set()}
      disabled={false}
      roundStatus="awaiting_human"
      followupPending={props.pending ?? props.running !== undefined}
      followupRunning={props.running}
      followupFailure={props.failure}
      onChange={() => {}}
      onFollowup={async () => {}}
      onCancelFollowup={props.cancel ?? (async () => {})}
      renderQuestion={() => null}
    />
  )
}

test('a generation reported by the round shows its branch and can be canceled', () => {
  const cancel = vi.fn(async () => {})
  const { container } = render(<Workspace running={['Scope']} cancel={cancel} />)
  expect(container.querySelector('.mindmap-workspace__progress')?.textContent).toContain(
    'Generating questions',
  )
  fireEvent.click(screen.getByRole('button', { name: 'View generating branch' }))
  const dialog = screen.getByRole('dialog')
  within(dialog).getByRole('heading', { name: 'Scope' })
  expect(within(dialog).getByRole('status').textContent).toContain('Generating questions')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel follow-up' }))
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('a failure reported by the round is shown on its branch once nothing generates', () => {
  const failure = {
    target: 'q1',
    error: new ApiError(0, 'clarify-followup-invalid', 'missing mindmap category'),
  }
  const { rerender } = render(<Workspace pending failure={failure} />)
  expect(screen.queryByRole('button', { name: 'View failed follow-up' })).toBeNull()
  rerender(<Workspace failure={failure} />)
  fireEvent.click(screen.getByRole('button', { name: 'View failed follow-up' }))
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(
    'missing mindmap category',
  )
})

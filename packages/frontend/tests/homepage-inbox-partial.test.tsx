// RFC-250 T19 — homepage inbox must remain honest when one of its two
// independent feeds fails: keep known rows/counts, show only the failed
// source's warning, and retry only that source.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import { InboxPreviewList } from '@/components/home/InboxPreviewList'
import { setBaseUrl, setToken } from '@/stores/auth'
import '@/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('RFC-250 homepage InboxPreviewList partial feed', () => {
  test('keeps known rows/count, avoids false empty, and retries only the failed source', async () => {
    let reviewCalls = 0
    let clarifyCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/api/reviews?status=pending')) {
        reviewCalls += 1
        return response([
          {
            nodeRunId: 'review-run-1',
            taskId: 'task-review',
            taskName: 'Review task',
            workflowId: 'workflow-1',
            workflowName: 'Code audit',
            reviewNodeId: 'review-node',
            title: 'Review the patch',
            description: '',
            currentVersionIndex: 1,
            reviewIteration: 0,
            decision: 'pending',
            awaitingReview: true,
            shardKey: null,
            createdAt: 1_700_000_000_000,
            decidedAt: null,
          },
        ])
      }
      if (url.includes('/api/clarify?status=awaiting_human')) {
        clarifyCalls += 1
        if (clarifyCalls === 1) {
          return response({ code: 'clarify-load-failed', message: 'clarify unavailable' }, 503)
        }
        return response([])
      }
      return response([])
    })

    const onCount = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <InboxPreviewList onCount={onCount} />
      </QueryClientProvider>,
    )

    expect(await screen.findByTestId('inbox-preview-review-review-run-1')).toBeTruthy()
    expect(screen.queryByTestId('inbox-preview-empty')).toBeNull()
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1))

    const partialWarning = await screen.findByTestId('inbox-preview-error-clarify')
    expect(partialWarning.className).toContain('notice-banner--warning')
    expect(partialWarning.className).not.toContain('notice-banner--error')
    const retry = await screen.findByRole('button', { name: 'Retry Clarify' })
    fireEvent.click(retry)
    await waitFor(() => expect(clarifyCalls).toBe(2))
    expect(reviewCalls).toBe(1)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry Clarify' })).toBeNull()
    })
  })

  test('a successful empty source plus one failed source stays a partial warning, not a full error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/api/reviews?status=pending')) return response([])
      if (url.includes('/api/clarify?status=awaiting_human')) {
        return response({ code: 'clarify-load-failed', message: 'clarify unavailable' }, 503)
      }
      return response([])
    })

    const onCount = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <InboxPreviewList onCount={onCount} />
      </QueryClientProvider>,
    )

    const warning = await screen.findByTestId('inbox-preview-error-clarify')
    expect(warning.className).toContain('notice-banner--warning')
    expect(screen.queryByTestId('inbox-preview-empty')).toBeNull()
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0))
  })
})

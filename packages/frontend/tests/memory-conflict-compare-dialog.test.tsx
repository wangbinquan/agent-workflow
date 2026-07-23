// RFC-041 PR4 — MemoryConflictCompareDialog contract.
//
// Locks:
// 1. Side-by-side renders existing (loaded via API) + candidate slots.
// 2. Approve & supersede fires the onApproveSupersede callback.
// 3. Reject fires onReject.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Memory } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryConflictCompareDialog } from '../src/components/memory/MemoryConflictCompareDialog'
import '../src/i18n'

function mk(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_x',
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'X',
    bodyMd: 'body',
    tags: [],
    status: 'approved',
    sourceKind: 'manual',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: 1000,
    createdAt: 500,
    version: 1,
    fusedIntoSkillId: null,
    ...overrides,
  }
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  // testing-library's cleanup() unmounts properly; manually wiping
  // document.body breaks Dialog's react-dom portal cleanup.
  cleanup()
  vi.restoreAllMocks()
})

function wrap(props: Partial<Parameters<typeof MemoryConflictCompareDialog>[0]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryConflictCompareDialog
        open
        onClose={props.onClose ?? (() => {})}
        candidate={
          props.candidate ?? mk({ id: 'mem_cand', title: 'Candidate title', bodyMd: 'new body' })
        }
        existingId={props.existingId ?? 'mem_existing'}
        onApproveSupersede={props.onApproveSupersede}
        onReject={props.onReject}
      />
    </QueryClientProvider>,
  )
}

describe('MemoryConflictCompareDialog', () => {
  test('renders both slots after existing detail loads', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          memory: mk({ id: 'mem_existing', title: 'Existing title', bodyMd: 'old body' }),
          ancestors: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    wrap({})
    // Both slot containers always render; assert the loaded titles appear.
    expect(await screen.findByText('Existing title', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByText('Candidate title')).toBeTruthy()
    expect(screen.getByTestId('memory-compare-existing')).toBeTruthy()
    expect(screen.getByTestId('memory-compare-candidate')).toBeTruthy()
  })

  test('Approve & supersede button calls onApproveSupersede', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ memory: mk({ id: 'mem_existing' }), ancestors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const onApproveSupersede = vi.fn()
    wrap({ onApproveSupersede })
    const btn = await screen.findByTestId('memory-compare-approve-supersede')
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(btn)
    expect(onApproveSupersede).toHaveBeenCalledTimes(1)
  })

  test('Reject button calls onReject', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ memory: mk({ id: 'mem_existing' }), ancestors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const onReject = vi.fn()
    wrap({ onReject })
    const btn = await screen.findByTestId('memory-compare-reject')
    fireEvent.click(btn)
    expect(onReject).toHaveBeenCalledTimes(1)
  })
})

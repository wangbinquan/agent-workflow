// RFC-045 — MemoryRow conditionally renders the [Edit] button.
//
// Locks:
//   * candidate / approved / archived rows render Edit when onEdit + editable
//   * superseded / rejected rows never render Edit
//   * onEdit unset → no Edit button
//   * editable=false → no Edit button (even if onEdit is set)
//   * click invokes onEdit

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { MemoryRow } from '../src/components/memory/MemoryRow'
import '../src/i18n'

function mk(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_x',
    scopeType: 'global',
    scopeId: null,
    title: 'Test',
    status: 'approved',
    tags: [],
    approvedAt: 1000,
    version: 1,
    distillAction: null,
    fusedIntoSkillId: null,
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('MemoryRow [Edit] button — RFC-045', () => {
  test.each(['candidate', 'approved', 'archived'] as const)(
    'renders Edit button when status=%s + onEdit set',
    (status) => {
      render(<MemoryRow memory={mk({ status })} onEdit={() => {}} />)
      expect(screen.queryByTestId('memory-row-mem_x-edit')).toBeTruthy()
    },
  )

  test.each(['superseded', 'rejected'] as const)(
    'does NOT render Edit button when status=%s',
    (status) => {
      render(<MemoryRow memory={mk({ status })} onEdit={() => {}} />)
      expect(screen.queryByTestId('memory-row-mem_x-edit')).toBeNull()
    },
  )

  test('no onEdit → no Edit button (even on approved row)', () => {
    render(<MemoryRow memory={mk({ status: 'approved' })} />)
    expect(screen.queryByTestId('memory-row-mem_x-edit')).toBeNull()
  })

  test('editable=false → no Edit button (non-admin viewer)', () => {
    render(<MemoryRow memory={mk({ status: 'approved' })} onEdit={() => {}} editable={false} />)
    expect(screen.queryByTestId('memory-row-mem_x-edit')).toBeNull()
  })

  test('click invokes onEdit', () => {
    let clicked = 0
    render(<MemoryRow memory={mk({ status: 'approved' })} onEdit={() => clicked++} />)
    fireEvent.click(screen.getByTestId('memory-row-mem_x-edit'))
    expect(clicked).toBe(1)
  })
})

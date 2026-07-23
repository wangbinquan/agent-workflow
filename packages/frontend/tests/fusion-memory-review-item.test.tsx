// RFC-101 — the fusion approval lists must show each memory's title + body
// (not a bare id), so the merger can actually review what was incorporated.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Memory } from '@agent-workflow/shared'
import { MemoryReviewItem } from '../src/components/fusion/MemoryReviewItem'
import i18n from '../src/i18n'

function mk(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm-1',
    scopeType: 'global',
    scopeId: null,
    title: 'Use two-space indentation',
    bodyMd: 'Always indent with two spaces, never tabs.',
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
    approvedAt: null,
    createdAt: 0,
    version: 1,
    fusedIntoSkillId: null,
    ...overrides,
  }
}

describe('MemoryReviewItem', () => {
  test('shows title + body (the reviewable content) when loaded', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ul>
        <MemoryReviewItem id="m-1" mem={mk()} loading={false} />
      </ul>,
    )
    expect(screen.getByText('Use two-space indentation')).toBeTruthy()
    expect(screen.getByText('Always indent with two spaces, never tabs.')).toBeTruthy()
  })

  test('shows the skip reason for skipped memories', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ul>
        <MemoryReviewItem id="m-2" mem={mk({ id: 'm-2' })} loading={false} reason="redundant" />
      </ul>,
    )
    expect(screen.getByText('redundant')).toBeTruthy()
  })

  test('falls back to the id when the memory could not be loaded', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <ul>
        <MemoryReviewItem id="m-missing" mem={null} loading={false} />
      </ul>,
    )
    // id appears both as the fallback title and the id <code> — at least one.
    expect(screen.getAllByText('m-missing').length).toBeGreaterThan(0)
  })
})

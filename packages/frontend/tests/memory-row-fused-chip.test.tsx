// RFC-101 — MemoryRow renders a "fused → {skill} v{n}" chip on fused rows, and
// exposes an optional leading multi-select checkbox (used by the fuse picker).

import { describe, expect, test } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { MemoryRow } from '../src/components/memory/MemoryRow'
import i18n from '../src/i18n'

function mk(overrides: Partial<MemorySummary>): MemorySummary {
  return {
    id: 'm-1',
    scopeType: 'global',
    scopeId: null,
    title: 'lint preference',
    status: 'approved',
    tags: [],
    approvedAt: null,
    version: 1,
    distillAction: null,
    outputLang: null,
    ...overrides,
  }
}

describe('RFC-101 MemoryRow — fused chip', () => {
  test('fused row shows the provenance chip', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <MemoryRow
        memory={mk({ status: 'fused', fusedIntoSkill: 'lint', fusedIntoSkillVersion: 7 })}
      />,
    )
    const chip = screen.getByTestId('memory-row-m-1-fused')
    expect(chip.textContent).toContain('lint')
    expect(chip.textContent).toContain('v7')
  })

  test('non-fused row shows no chip', async () => {
    await i18n.changeLanguage('en-US')
    render(<MemoryRow memory={mk({ status: 'approved' })} />)
    expect(screen.queryByTestId('memory-row-m-1-fused')).toBeNull()
  })
})

describe('RFC-101 MemoryRow — optional select checkbox', () => {
  test('renders a checkbox and fires onChange when select prop is provided', async () => {
    await i18n.changeLanguage('en-US')
    let toggled = 0
    render(
      <MemoryRow
        memory={mk({ id: 'sel-1' })}
        select={{ checked: false, onChange: () => (toggled += 1) }}
      />,
    )
    const box = screen.getByTestId('memory-row-sel-1-select')
    fireEvent.click(box)
    expect(toggled).toBe(1)
  })

  test('no checkbox without the select prop', async () => {
    await i18n.changeLanguage('en-US')
    render(<MemoryRow memory={mk({ id: 'no-sel' })} />)
    expect(screen.queryByTestId('memory-row-no-sel-select')).toBeNull()
  })
})

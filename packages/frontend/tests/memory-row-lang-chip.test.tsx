// RFC-050 — MemoryRow renders a LangChip on candidate rows whose source
// distill job carried an outputLang. Locks:
//   - candidate + outputLang='zh-CN' → chip with '中' label and tooltip
//   - candidate + outputLang='en-US' → chip with 'EN' label
//   - candidate + outputLang=null/undefined → no chip
//   - approved / archived / superseded / rejected → no chip, even if
//     outputLang somehow leaked through (defensive)

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { MemoryRow } from '../src/components/memory/MemoryRow'
import i18n from '../src/i18n'

function mk(overrides: Partial<MemorySummary>): MemorySummary {
  return {
    id: 'm-1',
    scopeType: 'global',
    scopeId: null,
    title: 'always typecheck before push',
    status: 'candidate',
    tags: [],
    approvedAt: null,
    version: 1,
    distillAction: 'new',
    fusedIntoSkillId: null,
    outputLang: null,
    ...overrides,
  }
}

describe('RFC-050 MemoryRow — language chip', () => {
  test('candidate + outputLang zh-CN → chip rendered with label + tooltip', async () => {
    await i18n.changeLanguage('en-US')
    render(<MemoryRow memory={mk({ outputLang: 'zh-CN' })} />)
    const chip = screen.getByTestId('memory-row-m-1-lang')
    expect(chip.textContent).toBe('中')
    expect(chip.getAttribute('title')).toContain('简体中文')
    expect(chip.className).toContain('memory-row__lang--zh-CN')
  })

  test('candidate + outputLang en-US → chip rendered with EN label', async () => {
    await i18n.changeLanguage('en-US')
    render(<MemoryRow memory={mk({ id: 'm-en', outputLang: 'en-US' })} />)
    const chip = screen.getByTestId('memory-row-m-en-lang')
    expect(chip.textContent).toBe('EN')
    expect(chip.className).toContain('memory-row__lang--en-US')
  })

  test('candidate + outputLang null → no chip', () => {
    render(<MemoryRow memory={mk({ id: 'm-null', outputLang: null })} />)
    expect(screen.queryByTestId('memory-row-m-null-lang')).toBeNull()
  })

  test('approved row never renders chip (approved memories are "facts")', async () => {
    await i18n.changeLanguage('en-US')
    render(
      <MemoryRow
        memory={mk({
          id: 'm-app',
          status: 'approved',
          approvedAt: Date.now(),
          outputLang: 'zh-CN',
        })}
      />,
    )
    expect(screen.queryByTestId('memory-row-m-app-lang')).toBeNull()
  })

  test('archived / superseded / rejected rows also skip the chip', () => {
    for (const status of ['archived', 'superseded', 'rejected'] as const) {
      const { unmount } = render(
        <MemoryRow memory={mk({ id: `m-${status}`, status, outputLang: 'zh-CN' })} />,
      )
      expect(screen.queryByTestId(`memory-row-m-${status}-lang`)).toBeNull()
      unmount()
    }
  })
})

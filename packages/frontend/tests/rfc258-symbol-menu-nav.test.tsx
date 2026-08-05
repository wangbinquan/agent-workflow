// RFC-258 T6 — the navigation-session reducer (gate F-17: jumps snapshot the
// exact pre-jump view; pop restores it; duplicates dedupe; leaving clears)
// and the SymbolMenu (F-07 honest engine badge / F-08 guessed-references
// labelling / keyboard Esc).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '../src/i18n'
import { CODE_NAV_EMPTY, codeNavReducer, codeNavTop, type CodeNavEntry } from '../src/lib/codeNav'
import { SymbolMenu } from '../src/components/code/SymbolMenu'
import type { SymbolResolution } from '@agent-workflow/shared'

afterEach(cleanup)

const entry = (over: Partial<CodeNavEntry> = {}): CodeNavEntry => ({
  repoKey: '',
  side: 'worktree',
  filePath: 'src/a.ts',
  line: 10,
  viewMode: 'hunk',
  scrollTop: 120,
  ...over,
})

describe('codeNavReducer (F-17)', () => {
  test('push snapshots the origin incl. view mode + scroll; pop returns it', () => {
    const s1 = codeNavReducer(CODE_NAV_EMPTY, { type: 'push', from: entry() })
    expect(codeNavTop(s1)).toMatchObject({ filePath: 'src/a.ts', viewMode: 'hunk', scrollTop: 120 })
    const s2 = codeNavReducer(s1, { type: 'pop' })
    expect(s2.stack).toHaveLength(0)
  })

  test('consecutive identical spots dedupe; different lines do not', () => {
    let s = codeNavReducer(CODE_NAV_EMPTY, { type: 'push', from: entry() })
    s = codeNavReducer(s, { type: 'push', from: entry() })
    expect(s.stack).toHaveLength(1)
    s = codeNavReducer(s, { type: 'push', from: entry({ line: 20 }) })
    expect(s.stack).toHaveLength(2)
  })

  test('clear empties; pop on empty is a no-op', () => {
    const s = codeNavReducer(CODE_NAV_EMPTY, { type: 'push', from: entry() })
    expect(codeNavReducer(s, { type: 'clear' }).stack).toHaveLength(0)
    expect(codeNavReducer(CODE_NAV_EMPTY, { type: 'pop' })).toBe(CODE_NAV_EMPTY)
  })
})

const RESOLUTION: SymbolResolution = {
  requestedEngine: 'deep',
  engine: 'baseline',
  degradedReason: 'indexer-missing',
  symbol: 'verifyManifest',
  definitions: [{ repoKey: '', filePath: 'src/v.ts', side: 'worktree', startLine: 53 }],
  references: [
    {
      repoKey: '',
      filePath: 'tests/t.ts',
      side: 'worktree',
      startLine: 9,
      confidence: 'inferred',
    },
  ],
}

describe('<SymbolMenu />', () => {
  test('groups definitions/references, badges the actual engine + guessed refs, selects a row', () => {
    const onSelect = vi.fn()
    render(
      <SymbolMenu
        resolution={RESOLUTION}
        loading={false}
        anchor={{ x: 10, y: 10 }}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/基线|baseline/)).toBeTruthy()
    expect(screen.getByText(/已降级|degraded/)).toBeTruthy()
    expect(screen.getByText(/定义(1)|Definitions \(1\)/)).toBeTruthy()
    expect(screen.getByText(/推测——|guessed —/)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /v\.ts:53/ }))
    expect(onSelect).toHaveBeenCalledWith(RESOLUTION.definitions[0])
  })

  test('empty resolution renders the out-of-scope note; Esc closes', () => {
    const onClose = vi.fn()
    render(
      <SymbolMenu
        resolution={{ ...RESOLUTION, definitions: [], references: [] }}
        loading={false}
        anchor={{ x: 0, y: 0 }}
        onSelect={() => {}}
        onClose={onClose}
      />,
    )
    expect(screen.getByText(/未在本任务符号范围内|Not in this task/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

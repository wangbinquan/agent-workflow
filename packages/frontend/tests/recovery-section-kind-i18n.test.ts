// LOCKS: RFC-108 recovery banner — the user-reported "文案太技术看不懂" fix.
//
// describeRecoveryKind() must humanise every recovery_event kind (no raw enum
// like `boot-reap` ever reaches the user) and the zh/en bundles must stay
// symmetric + complete against the backend kind set. Mirrors <StuckTaskBanner>'s
// describeRule contract. If the backend (services/recovery.ts RecoveryEventKind)
// gains a kind, RECOVERY_EVENT_KINDS + these assertions flag the missing
// translation; until one lands, describeRecoveryKind falls back to the raw code.
//
// Also a source-level guard: locks the old <h2>恢复</h2> page__section +
// <code>{kind}</code> dump from creeping back, and that tasks.detail.tsx now
// delegates to the extracted component.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { describeRecoveryKind, RECOVERY_EVENT_KINDS } from '../src/components/tasks/RecoverySection'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

describe('describeRecoveryKind', () => {
  test('unknown kind falls back to the raw code (never a leaked i18n key)', () => {
    // i18next returns the key itself for a missing entry — describeRecoveryKind
    // must detect that and show the bare code instead of `tasks.recovery.kind.X`.
    const t = (k: string) => k
    expect(describeRecoveryKind('some-future-kind', t)).toBe('some-future-kind')
  })

  test('known kind resolves to its human label', () => {
    const t = (k: string) => (k === 'tasks.recovery.kind.auto-resume' ? '自动从断点继续运行' : k)
    expect(describeRecoveryKind('auto-resume', t)).toBe('自动从断点继续运行')
  })
})

describe('recovery kind bundle completeness', () => {
  const zhKind = zhCN.tasks.recovery.kind as Record<string, string>
  const enKind = enUS.tasks.recovery.kind as Record<string, string>

  test('every backend kind has a non-empty zh + en label', () => {
    for (const k of RECOVERY_EVENT_KINDS) {
      expect(zhKind[k], `zh missing label for ${k}`).toBeTruthy()
      expect(enKind[k], `en missing label for ${k}`).toBeTruthy()
    }
  })

  test('zh and en kind maps stay symmetric with the backend kind set', () => {
    const expected = [...RECOVERY_EVENT_KINDS].sort()
    expect(Object.keys(zhKind).sort()).toEqual(expected)
    expect(Object.keys(enKind).sort()).toEqual(expected)
  })
})

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const SECTION_SRC = readFileSync(
  join(REPO_ROOT, 'packages/frontend/src/components/tasks/RecoverySection.tsx'),
  'utf8',
)
const DETAIL_SRC = readFileSync(
  join(REPO_ROOT, 'packages/frontend/src/routes/tasks.detail.tsx'),
  'utf8',
)

describe('recovery banner source guards', () => {
  test('RecoverySection humanises kinds and is not the old h2 page__section', () => {
    expect(SECTION_SRC).toContain('describeRecoveryKind')
    // The old implementation leaked the raw enum in a <code> tag and rendered a
    // <h2> page__section that read like a second page heading.
    expect(SECTION_SRC).not.toContain('<code>{e.kind}')
    expect(SECTION_SRC).not.toContain('page__section task-detail__recovery')
  })

  test('tasks.detail.tsx delegates to the extracted component + shared isTerminal', () => {
    expect(DETAIL_SRC).toContain('<RecoverySection')
    expect(DETAIL_SRC).not.toContain('function RecoverySection')
    // isTerminal moved to lib/task-detail-tabs so the component can share it.
    expect(DETAIL_SRC).not.toContain('function isTerminal')
  })
})

// LOCKS: RFC-108 recovery banner — the user-reported "文案太技术看不懂" fix.
//
// The shared labelForCode('tasks.recovery.kind', kind) must humanise every
// recovery_event kind (no raw enum like `boot-reap` ever reaches the user) and
// the zh/en bundles must stay symmetric + complete against the backend kind
// set (RFC-203 T5c promoted the local describeRecoveryKind/describeRule pair
// to this one primitive). If the backend (services/recovery.ts
// RecoveryEventKind) gains a kind, RECOVERY_EVENT_KINDS + these assertions
// flag the missing translation; until one lands, labelForCode falls back to
// the raw code.
//
// Also a source-level guard: locks the old <h2>恢复</h2> page__section +
// <code>{kind}</code> dump from creeping back, and that tasks.detail.tsx now
// delegates to the extracted component.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'vitest'

import { RECOVERY_EVENT_KINDS } from '../src/components/tasks/RecoverySection'
import i18n from '../src/i18n'
import { labelForCode } from '../src/i18n/errors'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    if (i18n.isInitialized) resolve()
    else i18n.on('initialized', () => resolve())
  })
  await i18n.changeLanguage('zh-CN')
})

describe('labelForCode over recovery kinds (ex-describeRecoveryKind)', () => {
  test('unknown kind falls back to the raw code (never a leaked i18n key)', () => {
    expect(labelForCode('tasks.recovery.kind', 'some-future-kind')).toBe('some-future-kind')
  })

  test('known kind resolves to its human label', () => {
    expect(labelForCode('tasks.recovery.kind', 'auto-resume')).toBe(
      (zhCN.tasks.recovery.kind as Record<string, string>)['auto-resume'],
    )
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
    expect(SECTION_SRC).toContain("labelForCode('tasks.recovery.kind'")
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

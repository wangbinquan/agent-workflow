// Regression guard for the i18n batch-extraction pass (see /tmp/i18n-spec.md;
// follow-up to the frontend i18n-coverage audit). That pass moved ~134
// hardcoded user-facing strings out of components/routes/lib into the zh-CN /
// en-US bundles. These assertions lock in three things a future refactor could
// silently break:
//
//   1. zh-CN and en-US stay structurally 1:1 (incl. the `errors` Record, which
//      is typed `Record<string,string>` and therefore NOT covered by the
//      compile-time `Resources` parity check).
//   2. Newly-added interpolating keys keep their {{var}} placeholders (the
//      audit caught a case where `agents · {{n}}` had lost its count).
//   3. Representative call sites were actually rewired to t()/describeApiError
//      and no longer carry the old hardcoded literal.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zhCN } from '@/i18n/zh-CN'
import { enUS } from '@/i18n/en-US'

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...flattenKeys(v, prefix === '' ? k : `${prefix}.${k}`))
  }
  return out
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[k]
    return undefined
  }, obj)
}

const src = (rel: string): string => readFileSync(resolve(__dirname, '..', 'src', rel), 'utf8')

describe('i18n bundle parity', () => {
  test('zh-CN and en-US have an identical flattened key tree', () => {
    const zh = flattenKeys(zhCN).sort()
    const en = flattenKeys(enUS).sort()
    // Surface the precise drift if this ever fails.
    const onlyZh = zh.filter((k) => !en.includes(k))
    const onlyEn = en.filter((k) => !zh.includes(k))
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] })
  })

  test('every leaf value is a non-empty string in both bundles', () => {
    for (const path of flattenKeys(zhCN)) {
      expect(typeof get(zhCN, path), `zhCN ${path}`).toBe('string')
      expect((get(zhCN, path) as string).length, `zhCN ${path}`).toBeGreaterThan(0)
      expect((get(enUS, path) as string).length, `enUS ${path}`).toBeGreaterThan(0)
    }
  })
})

describe('i18n batch-extraction — new keys', () => {
  const newKeys = [
    'common.close',
    'common.selectAnOption',
    'common.ariaActions',
    'common.ariaExpandColumn',
    'common.removeAria',
    'common.duplicateError',
    'common.emptyResource',
    'common.startedAt',
    'common.finishedAt',
    'account.pleaseSignIn',
    'account.roles.admin',
    'account.roles.user',
    'skills.fileTreeHeader',
    'skills.fileDeleteButton',
    'launch.gitPicker.branchLabel',
    'launch.filesPicker.loading',
    'plugins.errors.specRequired',
    'plugins.sourceKind.npm',
    'nodeDrawer.statSession',
    'session.toolInput',
  ]
  for (const k of newKeys) {
    test(`key exists in both bundles: ${k}`, () => {
      expect(typeof get(zhCN, k)).toBe('string')
      expect(typeof get(enUS, k)).toBe('string')
    })
  }

  test('reviews.decision covers all four decision statuses', () => {
    for (const d of ['approved', 'rejected', 'iterated', 'pending']) {
      expect(typeof get(zhCN, `reviews.decision.${d}`), `zh ${d}`).toBe('string')
      expect(typeof get(enUS, `reviews.decision.${d}`), `en ${d}`).toBe('string')
    }
  })

  test('interpolating keys keep their {{var}} placeholders', () => {
    // The scope-row count variant must keep {{n}} (audit found it had been
    // collapsed onto the plain `memory.scope` labels, dropping the count).
    expect(zhCN.memory.scopeRow.agentCount).toContain('{{n}}')
    expect(enUS.memory.scopeRow.agentCount).toContain('{{n}}')
    // ...and stay distinct from the plain scope-type label.
    expect(enUS.memory.scopeRow.agentCount).not.toBe(enUS.memory.scope.agent)
    expect(zhCN.inspector.missingOption).toContain('{{value}}')
    expect(enUS.inspector.missingOption).toContain('{{value}}')
    expect(enUS.reviews.plantumlSyntaxErrorLineAndReason).toContain('{{line}}')
    expect(enUS.reviews.plantumlSyntaxErrorLineAndReason).toContain('{{reason}}')
  })
})

describe('i18n batch-extraction — call sites rewired', () => {
  test('Dialog close button uses t(common.close), not a hardcoded aria-label', () => {
    const s = src('components/Dialog.tsx')
    expect(s).toContain("t('common.close')")
    expect(s).not.toMatch(/aria-label="Close"/)
  })

  test('SkillFileTree header/empty/delete go through t()', () => {
    const s = src('components/SkillFileTree.tsx')
    expect(s).toContain("t('skills.fileTreeHeader')")
    expect(s).not.toContain('No files yet.')
    expect(s).not.toContain('Delete file')
  })

  test('GitPicker labels go through t()', () => {
    const s = src('components/launch/GitPicker.tsx')
    expect(s).toContain("t('launch.gitPicker.branchLabel')")
    expect(s).not.toMatch(/label="Branch"/)
    expect(s).not.toContain('From (sha / ref)')
  })

  test('plugin-form validation returns i18n keys, not English sentences', () => {
    const s = src('lib/plugin-form.ts')
    expect(s).toContain("'plugins.errors.specRequired'")
    expect(s).not.toContain("'spec is required'")
  })

  test('reviews list renders the decision via t(reviews.decision.*)', () => {
    const s = src('routes/reviews.tsx')
    expect(s).toMatch(/t\(`reviews\.decision\.\$\{[^}]+\}`\)/)
  })

  test('agents.detail surfaces API errors via the shared ErrorBanner (describeApiError inside)', () => {
    // RFC-169: the split detail renders <ErrorBanner> (which runs describeApiError
    // internally) instead of a bare describeApiError call; mutation-channel errors
    // still flow through DetailHeaderActions.errors → describeApiError.
    const s = src('routes/agents.detail.tsx')
    expect(s).toContain('ErrorBanner')
  })
})

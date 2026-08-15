// RFC-043 T7 — i18n completeness for the distill-job detail page.
//
// The global i18n-keys-symmetry.test.ts already locks zh-CN ⇄ en-US
// union; this file asserts the specific keys RFC-043 added (memory
// .sourceKind.* + memory.distillJobDetail.*) are non-empty in both
// bundles and that placeholder tokens match across locales.

import { describe, expect, test } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const SOURCE_KINDS = ['clarify', 'review', 'feedback', 'manual'] as const

const DETAIL_TOP = [
  'permissionRequired',
  'attempt',
  'attemptsCount',
  'attemptPickerLabel',
  'candidateStatus',
  'captureFailed',
  'dedupSnapshotLabel',
  'loadError',
  'noCandidates',
  'noConversation',
  'noDedupSnapshot',
  'noSourceEvents',
  'openInQueue',
  'sessionLoadError',
  'sourceDeleted',
  'stderrLabel',
] as const

const DETAIL_SECTIONS = ['candidates', 'conversation', 'scope', 'sourceEvents'] as const

function placeholders(s: string): string[] {
  const out = s.match(/\{\{[^}]+\}\}/g) ?? []
  return [...out].sort()
}

describe('RFC-043 i18n keys present + symmetric in both locales', () => {
  test('memory.sourceKind.* exists in both bundles', () => {
    for (const k of SOURCE_KINDS) {
      expect(zhCN.memory.sourceKind[k].length, `zhCN.memory.sourceKind.${k}`).toBeGreaterThan(0)
      expect(enUS.memory.sourceKind[k].length, `enUS.memory.sourceKind.${k}`).toBeGreaterThan(0)
    }
  })

  test('memory.distillJobDetail.* top-level + section keys all populated', () => {
    for (const k of DETAIL_TOP) {
      expect(
        zhCN.memory.distillJobDetail[k].length,
        `zhCN.memory.distillJobDetail.${k}`,
      ).toBeGreaterThan(0)
      expect(
        enUS.memory.distillJobDetail[k].length,
        `enUS.memory.distillJobDetail.${k}`,
      ).toBeGreaterThan(0)
    }
    for (const k of DETAIL_SECTIONS) {
      expect(
        zhCN.memory.distillJobDetail.section[k].length,
        `zhCN.memory.distillJobDetail.section.${k}`,
      ).toBeGreaterThan(0)
      expect(
        enUS.memory.distillJobDetail.section[k].length,
        `enUS.memory.distillJobDetail.section.${k}`,
      ).toBeGreaterThan(0)
    }
  })

  test('placeholders match across locales for keys that have them', () => {
    // Each side of the pair must reference the same `{{var}}` set.
    const pairs: Array<[string, string, string]> = [
      ['attempt', zhCN.memory.distillJobDetail.attempt, enUS.memory.distillJobDetail.attempt],
      [
        'attemptsCount',
        zhCN.memory.distillJobDetail.attemptsCount,
        enUS.memory.distillJobDetail.attemptsCount,
      ],
      [
        'candidateStatus',
        zhCN.memory.distillJobDetail.candidateStatus,
        enUS.memory.distillJobDetail.candidateStatus,
      ],
    ]
    for (const [name, zh, en] of pairs) {
      expect(placeholders(zh), `placeholders mismatch: ${name}`).toEqual(placeholders(en))
    }
  })
})

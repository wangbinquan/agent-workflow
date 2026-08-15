// RFC-041 PR4 — i18n completeness for the platform memory + task feedback UI.
//
// The global i18n-keys-symmetry.test.ts already locks zh-CN ⇄ en-US union;
// this file asserts the specific keys RFC-041 PR4 added are non-empty in
// both bundles. If a future rename breaks one side it surfaces here with a
// readable error before the symmetry test trips on a mass diff.

import { describe, expect, test } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const NAV_KEYS = ['memory', 'memoryHint', 'memoryBadge'] as const
const MEMORY_TOP = [
  'title',
  'empty',
  'confirmDelete',
  'confirmArchive',
  'archiveDialogTitle',
  'deleteDialogTitle',
  'dialogCancel',
  'dialogConfirm',
] as const
// RFC-121: added the "fusion" tab + memory.fusion.* surface; the inbox-side
// pending-memory keys (pendingMemoryGroup/pendingMemoryEmpty/memoryItemSubtitle)
// were deleted when fusions + memory candidates left the inbox drawer.
const MEMORY_TABS = ['approvalQueue', 'all', 'byScope', 'distillJobs', 'fusion'] as const
const MEMORY_FUSION = ['subtitle', 'empty', 'error', 'retry'] as const
const MEMORY_ACTIONS = [
  'approve',
  'approveSupersede',
  'reject',
  'archive',
  'unarchive',
  'delete',
  'compare',
] as const
const MEMORY_SCOPES = ['agent', 'workflow', 'repo', 'global'] as const
const MEMORY_STATUSES = ['candidate', 'approved', 'archived', 'superseded', 'rejected'] as const
const DISTILL_ACTIONS = ['new', 'updateOf', 'duplicateOf', 'conflictWith'] as const
const FEEDBACK_KEYS = [
  'title',
  'hint',
  'placeholder',
  'submit',
  'submitting',
  'empty',
  'distilled',
  'rateLimit',
  'secretHint',
  'submitError',
  'loadError',
  'submittedJustNow',
] as const

describe('RFC-041 PR4 i18n keys present in both locales', () => {
  test('nav.memory*', () => {
    for (const k of NAV_KEYS) {
      expect(zhCN.nav[k].length, `zhCN.nav.${k}`).toBeGreaterThan(0)
      expect(enUS.nav[k].length, `enUS.nav.${k}`).toBeGreaterThan(0)
    }
  })

  test('memory.* surface', () => {
    for (const k of MEMORY_TOP) {
      expect(zhCN.memory[k].length).toBeGreaterThan(0)
      expect(enUS.memory[k].length).toBeGreaterThan(0)
    }
    for (const k of MEMORY_TABS) {
      expect(zhCN.memory.tab[k].length).toBeGreaterThan(0)
      expect(enUS.memory.tab[k].length).toBeGreaterThan(0)
    }
    for (const k of MEMORY_FUSION) {
      expect(zhCN.memory.fusion[k].length).toBeGreaterThan(0)
      expect(enUS.memory.fusion[k].length).toBeGreaterThan(0)
    }
    for (const k of MEMORY_ACTIONS) {
      expect(zhCN.memory.action[k].length).toBeGreaterThan(0)
      expect(enUS.memory.action[k].length).toBeGreaterThan(0)
    }
    for (const k of MEMORY_SCOPES) {
      expect(zhCN.memory.scope[k].length).toBeGreaterThan(0)
      expect(enUS.memory.scope[k].length).toBeGreaterThan(0)
    }
    for (const k of MEMORY_STATUSES) {
      expect(zhCN.memory.status[k].length).toBeGreaterThan(0)
      expect(enUS.memory.status[k].length).toBeGreaterThan(0)
    }
    for (const k of DISTILL_ACTIONS) {
      expect(zhCN.memory.distillAction[k].length).toBeGreaterThan(0)
      expect(enUS.memory.distillAction[k].length).toBeGreaterThan(0)
    }
  })

  test('taskFeedback.* surface', () => {
    for (const k of FEEDBACK_KEYS) {
      expect(zhCN.taskFeedback[k].length, `zhCN.taskFeedback.${k}`).toBeGreaterThan(0)
      expect(enUS.taskFeedback[k].length, `enUS.taskFeedback.${k}`).toBeGreaterThan(0)
    }
  })

  test('detail.memories', () => {
    expect(zhCN.detail.memories.length).toBeGreaterThan(0)
    expect(enUS.detail.memories.length).toBeGreaterThan(0)
  })

  test('memory.candidate.from + distillAction placeholders match across locales', () => {
    const placeholders = (s: string): string[] => {
      const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
      const out: string[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) out.push(m[1]!)
      return [...new Set(out)].sort()
    }
    expect(placeholders(zhCN.memory.candidate.from)).toEqual(
      placeholders(enUS.memory.candidate.from),
    )
    expect(placeholders(zhCN.memory.distillAction.updateOf)).toEqual(
      placeholders(enUS.memory.distillAction.updateOf),
    )
  })
})

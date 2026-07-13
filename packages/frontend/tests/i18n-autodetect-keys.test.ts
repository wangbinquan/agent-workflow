// RFC-038 T5 — locks the i18n keys added for the agent-form dependency
// autodetect feature. The global `i18n-keys-symmetry.test.ts` already
// enforces zh ⇄ en union equality; this file is the explicit list of which
// keys must exist and be non-empty in both locales.

import { describe, expect, test } from 'vitest'
import { enUS as en } from '@/i18n/en-US'
import { zhCN as zh } from '@/i18n/zh-CN'

const KEYS_TO_CHECK = [
  'agentForm.autodetect.button',
  // RFC-173 follow-up: disabledHint deleted — the button is always clickable now.
  'agentForm.autodetect.dialogTitle',
  'agentForm.autodetect.dialogHint',
  'agentForm.autodetect.emptyText',
  'agentForm.autodetect.groupLoadFailed',
  'agentForm.autodetect.groupName.agents',
  'agentForm.autodetect.groupName.skills',
  'agentForm.autodetect.groupName.mcps',
  'agentForm.autodetect.groupName.plugins',
  'agentForm.autodetect.section.agents',
  'agentForm.autodetect.section.skills',
  'agentForm.autodetect.section.mcps',
  'agentForm.autodetect.section.plugins',
  'agentForm.autodetect.cancelButton',
  'agentForm.autodetect.applyButton',
  'agentForm.autodetect.closeButton',
]

function deep(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : undefined
}

describe('RFC-038 — autodetect i18n keys present and non-empty', () => {
  for (const key of KEYS_TO_CHECK) {
    test(`en-US: ${key} non-empty`, () => {
      const v = deep(en, key)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
    test(`zh-CN: ${key} non-empty`, () => {
      const v = deep(zh, key)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
  }
})

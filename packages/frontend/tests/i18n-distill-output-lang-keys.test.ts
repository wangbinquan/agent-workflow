// RFC-050 — locks the i18n keys added for the distill output language
// feature. zh-CN / en-US symmetry is enforced globally by
// i18n-keys-symmetry.test.ts; this file is the explicit catalogue of
// keys the feature relies on so a missing one fails fast with a clear
// finger-pointing error.

import { describe, expect, test } from 'vitest'
import { enUS as en } from '@/i18n/en-US'
import { zhCN as zh } from '@/i18n/zh-CN'

const KEYS_TO_CHECK: ReadonlyArray<[string, (r: unknown) => string | undefined]> = [
  ['settings.tabMemory', (r) => deep(r, 'settings.tabMemory')],
  ['settings.memoryDistillLangLabel', (r) => deep(r, 'settings.memoryDistillLangLabel')],
  ['settings.memoryDistillLangHint', (r) => deep(r, 'settings.memoryDistillLangHint')],
  ['settings.memoryDistillLangDefault', (r) => deep(r, 'settings.memoryDistillLangDefault')],
  ['settings.memoryDistillLangZhCN', (r) => deep(r, 'settings.memoryDistillLangZhCN')],
  ['settings.memoryDistillLangEnUS', (r) => deep(r, 'settings.memoryDistillLangEnUS')],
  [
    'memory.distillJobDetail.outputLangLabel',
    (r) => deep(r, 'memory.distillJobDetail.outputLangLabel'),
  ],
  [
    'memory.distillJobDetail.outputLang.default',
    (r) => deep(r, 'memory.distillJobDetail.outputLang.default'),
  ],
  [
    'memory.distillJobDetail.outputLang.zh-CN',
    (r) => deep(r, 'memory.distillJobDetail.outputLang.zh-CN'),
  ],
  [
    'memory.distillJobDetail.outputLang.en-US',
    (r) => deep(r, 'memory.distillJobDetail.outputLang.en-US'),
  ],
  ['memory.candidateRow.lang.zh-CN', (r) => deep(r, 'memory.candidateRow.lang.zh-CN')],
  ['memory.candidateRow.lang.en-US', (r) => deep(r, 'memory.candidateRow.lang.en-US')],
  [
    'memory.candidateRow.langTooltip.zh-CN',
    (r) => deep(r, 'memory.candidateRow.langTooltip.zh-CN'),
  ],
  [
    'memory.candidateRow.langTooltip.en-US',
    (r) => deep(r, 'memory.candidateRow.langTooltip.en-US'),
  ],
]

function deep(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : undefined
}

describe('RFC-050 — i18n keys present and non-empty in both locales', () => {
  for (const [key, get] of KEYS_TO_CHECK) {
    test(`en-US: ${key} is non-empty`, () => {
      const v = get(en)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
    test(`zh-CN: ${key} is non-empty`, () => {
      const v = get(zh)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
  }
})

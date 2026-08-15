import { describe, expect, test } from 'vitest'
import { PERMISSION_CATALOG } from '@agent-workflow/shared'
import { enUS } from '@/i18n/en-US'
import { zhCN } from '@/i18n/zh-CN'

function resolve(bundle: unknown, key: string): unknown {
  let current = bundle
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

describe('RFC-305 permission catalog translations', () => {
  test('every catalog label and description resolves in both locales', () => {
    for (const entry of Object.values(PERMISSION_CATALOG)) {
      for (const bundle of [enUS, zhCN]) {
        expect(resolve(bundle, entry.labelKey)).toEqual(expect.any(String))
        expect(resolve(bundle, entry.descriptionKey)).toEqual(expect.any(String))
      }
    }
  })

  test('locale keysets remain symmetric', () => {
    expect(Object.keys(enUS.permissions.catalog).sort()).toEqual(
      Object.keys(zhCN.permissions.catalog).sort(),
    )
  })
})

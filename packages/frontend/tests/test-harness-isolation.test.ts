// Regression guard for process-global frontend test state.
//
// The suite deliberately chooses zh-CN as its baseline, while both cases
// switch away to en-US. The shared setup must restore the inherited suite
// baseline before whichever case Vitest shuffles next.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import i18n from '@/i18n'

describe('frontend test harness isolation', () => {
  let originalLanguage = 'en-US'

  beforeAll(async () => {
    originalLanguage = i18n.resolvedLanguage ?? i18n.language
    await i18n.changeLanguage('zh-CN')
  })

  afterAll(async () => {
    await i18n.changeLanguage(originalLanguage)
  })

  beforeEach(() => {
    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })

  for (const label of ['first mutation', 'second mutation']) {
    test(label, async () => {
      await i18n.changeLanguage('en-US')
      expect(i18n.resolvedLanguage).toBe('en-US')
    })
  }
})

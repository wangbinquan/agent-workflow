// RFC-061 follow-up — kind label + class helpers for the suspensions
// list. Locks the SignalKind → i18n key + CSS class mapping the
// list / detail / inbox routes share.

import { describe, expect, test } from 'vitest'
import { kindClass, kindLabel } from '@/routes/suspensions'

describe('suspensions helpers', () => {
  const fakeT = (key: string): string => `t(${key})`

  test('kindClass — self-clarify and cross-clarify both map to clarify', () => {
    expect(kindClass('self-clarify')).toBe('clarify')
    expect(kindClass('cross-clarify')).toBe('clarify')
  })

  test('kindClass — review maps to review', () => {
    expect(kindClass('review')).toBe('review')
  })

  test('kindClass — retry-pending-* maps to retry', () => {
    expect(kindClass('retry-pending-auto')).toBe('retry')
    expect(kindClass('retry-pending-human')).toBe('retry')
  })

  test('kindClass — await-external-data maps to other', () => {
    expect(kindClass('await-external-data')).toBe('other')
  })

  test('kindLabel — every SignalKind resolves to a translation key under nav.inbox', () => {
    expect(kindLabel(fakeT, 'self-clarify')).toBe('t(nav.inbox.suspensionKindSelfClarify)')
    expect(kindLabel(fakeT, 'cross-clarify')).toBe('t(nav.inbox.suspensionKindCrossClarify)')
    expect(kindLabel(fakeT, 'review')).toBe('t(nav.inbox.suspensionKindReview)')
    expect(kindLabel(fakeT, 'retry-pending-auto')).toBe('t(nav.inbox.suspensionKindRetryAuto)')
    expect(kindLabel(fakeT, 'retry-pending-human')).toBe('t(nav.inbox.suspensionKindRetryHuman)')
    expect(kindLabel(fakeT, 'await-external-data')).toBe('t(nav.inbox.suspensionKindAwaitExternal)')
  })
})

// RFC-169 (T2) — locks the split-page left-rail search filter: case-insensitive
// match over title OR subtitle, empty query returns identity.

import { describe, expect, test } from 'vitest'
import { filterResourceCards } from '../src/lib/resource-card-filter'

const items = [
  { title: 'code-worker', subtitle: 'writes code' },
  { title: 'auditor', subtitle: 'audits diffs', searchText: 'Leader · Alice 3 members' },
  { title: 'fixer', subtitle: undefined },
]

describe('filterResourceCards', () => {
  test('empty query returns the same array by identity', () => {
    expect(filterResourceCards('', items)).toBe(items)
  })

  test('whitespace-only query is treated as empty (identity)', () => {
    expect(filterResourceCards('   ', items)).toBe(items)
  })

  test('matches on title, case-insensitive', () => {
    expect(filterResourceCards('CODE', items).map((i) => i.title)).toEqual(['code-worker'])
  })

  test('matches on subtitle', () => {
    expect(filterResourceCards('audits', items).map((i) => i.title)).toEqual(['auditor'])
  })

  test('matches optional visible-facts search text', () => {
    expect(filterResourceCards('alice', items).map((i) => i.title)).toEqual(['auditor'])
    expect(filterResourceCards('3 MEMBERS', items).map((i) => i.title)).toEqual(['auditor'])
  })

  test('title OR subtitle — a title hit and a subtitle hit both surface', () => {
    // "code" is in code-worker's title; "diffs" is only in auditor's subtitle.
    expect(filterResourceCards('code', items).map((i) => i.title)).toEqual(['code-worker'])
    expect(filterResourceCards('diffs', items).map((i) => i.title)).toEqual(['auditor'])
  })

  test('undefined subtitle does not throw and simply cannot match', () => {
    expect(filterResourceCards('fix', items).map((i) => i.title)).toEqual(['fixer'])
    expect(filterResourceCards('zzz', items)).toEqual([])
  })

  test('no match → empty array', () => {
    expect(filterResourceCards('nonexistent', items)).toEqual([])
  })
})

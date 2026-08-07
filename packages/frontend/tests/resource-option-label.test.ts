// RFC-264 — picker labels must stay tellable apart once names are ordinary
// human-readable text.
//
// User decision (2026-08-07): rather than a stricter name rule, look-alike
// candidates are separated in the UI by an id suffix — and ONLY the candidates
// that actually collide, so an ordinary dropdown never grows a wall of hex.
//
// What this locks:
//   1. no collision ⇒ no suffix anywhere (the common case),
//   2. the owner segment still resolves same-name-different-owner on its own,
//   3. same name AND same owner ⇒ every colliding row carries its own suffix,
//   4. the suffix is the id's last 6 characters, fixed width.

import { describe, expect, test } from 'vitest'
import {
  buildResourceOptionLabeler,
  RESOURCE_OPTION_ID_SUFFIX_LENGTH,
  resourceOptionLabel,
  type ResourceOptionRow,
} from '../src/lib/resource-option-label'

/** Label every row of a list, as the pickers do. */
function labelAll(rows: readonly ResourceOptionRow[]): Map<string, string> {
  const label = buildResourceOptionLabeler(rows)
  return new Map(rows.map((row) => [row.id, label(row)]))
}

describe('resourceOptionLabel (unchanged base layer)', () => {
  test('appends the owner only when there is one', () => {
    expect(resourceOptionLabel('代码审计', 'alice')).toBe('代码审计 · alice')
    expect(resourceOptionLabel('代码审计')).toBe('代码审计')
    expect(resourceOptionLabel('代码审计', '   ')).toBe('代码审计')
  })
})

describe('RFC-264 buildResourceOptionLabeler', () => {
  test('distinct names get NO id suffix', () => {
    const labels = labelAll([
      { id: '01JQZZZZZZZZZZZZZZZZ7K3M2Q', name: '代码审计流水线', owner: 'alice' },
      { id: '01JQZZZZZZZZZZZZZZZZB9XZ04', name: '发版前质量门', owner: 'alice' },
    ])
    expect(labels.get('01JQZZZZZZZZZZZZZZZZ7K3M2Q')).toBe('代码审计流水线 · alice')
    expect(labels.get('01JQZZZZZZZZZZZZZZZZB9XZ04')).toBe('发版前质量门 · alice')
  })

  test('same name, different owners — the owner segment already separates them', () => {
    const labels = labelAll([
      { id: '01JQZZZZZZZZZZZZZZZZ7K3M2Q', name: '代码审计', owner: 'alice' },
      { id: '01JQZZZZZZZZZZZZZZZZB9XZ04', name: '代码审计', owner: 'bob' },
    ])
    expect(labels.get('01JQZZZZZZZZZZZZZZZZ7K3M2Q')).toBe('代码审计 · alice')
    expect(labels.get('01JQZZZZZZZZZZZZZZZZB9XZ04')).toBe('代码审计 · bob')
  })

  test('same name AND same owner — each colliding row carries its own id suffix', () => {
    const labels = labelAll([
      { id: '01JQZZZZZZZZZZZZZZZZ7K3M2Q', name: '代码审计', owner: 'alice' },
      { id: '01JQZZZZZZZZZZZZZZZZB9XZ04', name: '代码审计', owner: 'alice' },
      { id: '01JQZZZZZZZZZZZZZZZZAAAAAA', name: '独一无二', owner: 'alice' },
    ])
    expect(labels.get('01JQZZZZZZZZZZZZZZZZ7K3M2Q')).toBe('代码审计 · alice · #7K3M2Q')
    expect(labels.get('01JQZZZZZZZZZZZZZZZZB9XZ04')).toBe('代码审计 · alice · #B9XZ04')
    // The non-colliding neighbour in the SAME list stays clean.
    expect(labels.get('01JQZZZZZZZZZZZZZZZZAAAAAA')).toBe('独一无二 · alice')
  })

  test('ownerless rows (webhook target picker) collide on the bare name', () => {
    const labels = labelAll([
      { id: '01JQZZZZZZZZZZZZZZZZ7K3M2Q', name: '代码审计' },
      { id: '01JQZZZZZZZZZZZZZZZZB9XZ04', name: '代码审计' },
    ])
    expect(labels.get('01JQZZZZZZZZZZZZZZZZ7K3M2Q')).toBe('代码审计 · #7K3M2Q')
    expect(labels.get('01JQZZZZZZZZZZZZZZZZB9XZ04')).toBe('代码审计 · #B9XZ04')
  })

  test('the suffix is exactly the last N characters of the id', () => {
    const id = '01JQZZZZZZZZZZZZZZZZ7K3M2Q'
    const labels = labelAll([
      { id, name: 'dup' },
      { id: '01JQZZZZZZZZZZZZZZZZB9XZ04', name: 'dup' },
    ])
    expect(labels.get(id)).toBe(`dup · #${id.slice(-RESOURCE_OPTION_ID_SUFFIX_LENGTH)}`)
    expect(RESOURCE_OPTION_ID_SUFFIX_LENGTH).toBe(6)
  })

  test('an empty list still yields a usable labeler (loading picker)', () => {
    expect(labelAll([]).size).toBe(0)
    expect(buildResourceOptionLabeler([])({ id: 'x', name: '代码审计' })).toBe('代码审计')
  })
})

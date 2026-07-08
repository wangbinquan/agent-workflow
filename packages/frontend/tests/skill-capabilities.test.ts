// RFC-151 PR-1 — skillCapabilities(sourceKind) capability-table lock.
//
// /skills/$name used to re-derive `sourceKind === 'managed'` at seven sites
// (fuse button, content save, desc hint, body editor, file-tree writability,
// version history). The capability object names each ability once; this test
// locks the table so a future sourceKind (or a capability split, e.g.
// external skills becoming fusable) is a deliberate edit here — not an
// accidental drift at one of the consumption sites.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { skillCapabilities } from '../src/lib/skill-capabilities'

describe('skillCapabilities — table lock', () => {
  test('managed → every capability granted', () => {
    expect(skillCapabilities('managed')).toEqual({
      canFuse: true,
      canEditContent: true,
      canBrowseFilesWritable: true,
      showManagedHint: true,
      showVersionHistory: true,
    })
  })

  test('external → read-only everywhere', () => {
    expect(skillCapabilities('external')).toEqual({
      canFuse: false,
      canEditContent: false,
      canBrowseFilesWritable: false,
      showManagedHint: false,
      showVersionHistory: false,
    })
  })
})

describe('skills.detail consumes capability bits, not a scattered isManaged flag', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'skills.detail.tsx'), 'utf8')

  test('imports skillCapabilities and reads caps.*', () => {
    expect(src).toContain("import { skillCapabilities } from '@/lib/skill-capabilities'")
    for (const bit of [
      'caps.canFuse',
      'caps.canEditContent',
      'caps.canBrowseFilesWritable',
      'caps.showManagedHint',
      'caps.showVersionHistory',
    ]) {
      expect(src.includes(bit), `skills.detail.tsx must read ${bit}`).toBe(true)
    }
  })

  test('the local isManaged alias is gone', () => {
    // The header chip may still *display* the raw sourceKind (that is data,
    // not a capability gate); what must not come back is the derived boolean.
    expect(src.includes('isManaged')).toBe(false)
  })
})

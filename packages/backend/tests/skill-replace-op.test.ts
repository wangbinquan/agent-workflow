// RFC-170 §6a — conflict-replace removes a MANAGED occupier through the crash-safe
// delete op (root→.trash→DELETE→clean, boot-recoverable) instead of the old
// non-atomic rmSync+DELETE. The behavioral outcome (occupier replaced by the
// source candidate) is covered by skill-source-conflict-replace.test.ts; the
// crash recovery by skill-delete-op.test.ts. This locks the wiring so a refactor
// can't silently revert the managed path to the non-atomic removeSkillRowAndFiles.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src', 'services', 'skill-source.ts')

describe('RFC-170 replace op — managed occupier removal is crash-safe', () => {
  const src = readFileSync(SRC, 'utf-8')

  test('replaceSourceConflict routes a MANAGED occupier through deleteManagedSkillOp', () => {
    expect(src).toContain('deleteManagedSkillOp')
    // The managed branch must be keyed on the occupier being managed.
    expect(src).toMatch(/occupying\.sourceKind === 'managed'/)
  })

  test('external occupier still uses the atomic single-row drop (removeSkillRowAndFiles)', () => {
    // The external branch is preserved (no managed directory → a DB row drop is
    // already atomic; the op machinery is managed-only).
    expect(src).toContain('removeSkillRowAndFiles(db, fsOpts, occupying)')
  })
})

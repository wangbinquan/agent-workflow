// RFC-019: pure helpers driving the ZIP import UI. These are the predicates
// the ImportZipPanel uses to wire submit-disabled, rename validation, and
// the final decisions payload — locking them at unit level is much cheaper
// than driving the whole React tree.

import { describe, expect, test } from 'vitest'
import { SKILL_ZIP_LIMITS, type CommitSkillZipResponse } from '@agent-workflow/shared'
import type { SkillZipCandidateView } from '@agent-workflow/shared'
import {
  availableActionsFor,
  buildDecisionMap,
  deriveReviewSummary,
  deriveSubmitState,
  effectiveTargetName,
  initialDecisionFor,
  resultKind,
  rowsFromParseResponse,
  summarizeRows,
  validateSkillZipFile,
  validateRenameTarget,
  type RowState,
} from '../src/lib/skill-zip-import'

function candidate(
  name: string,
  conflict?: 'managed',
  canOverwrite?: boolean,
): SkillZipCandidateView {
  return {
    name,
    description: '',
    fileCount: 1,
    totalBytes: 10,
    warnings: [],
    ...(conflict !== undefined ? { conflict } : {}),
    ...(canOverwrite !== undefined ? { canOverwrite } : {}),
  }
}

describe('initialDecisionFor', () => {
  test('no conflict → import', () => {
    expect(initialDecisionFor(candidate('a')).action).toBe('import')
  })
  test('managed conflict → skip (safer than overwrite)', () => {
    expect(initialDecisionFor(candidate('a', 'managed')).action).toBe('skip')
  })
})

describe('availableActionsFor (RFC-102)', () => {
  test('no conflict → import + skip', () => {
    expect(availableActionsFor(candidate('a'))).toEqual(['import', 'skip'])
  })
  test('managed + canOverwrite → skip / overwrite / rename', () => {
    expect(availableActionsFor(candidate('a', 'managed', true))).toEqual([
      'skip',
      'overwrite',
      'rename',
    ])
  })
  test('managed without write permission → skip / rename (no overwrite)', () => {
    expect(availableActionsFor(candidate('a', 'managed', false))).toEqual(['skip', 'rename'])
  })
  test('managed with canOverwrite absent → skip / rename (default deny)', () => {
    expect(availableActionsFor(candidate('a', 'managed'))).toEqual(['skip', 'rename'])
  })
})

describe('validateRenameTarget', () => {
  function rows(
    self: string,
    others: Array<[name: string, action: RowState['decision']['action'], newName?: string]>,
  ): RowState[] {
    return [
      { candidate: candidate(self), decision: { action: 'rename', newName: '' } },
      ...others.map(
        ([n, action, newName]): RowState => ({
          candidate: candidate(n),
          decision: { action, newName: newName ?? '' },
        }),
      ),
    ]
  }

  test('empty input → empty', () => {
    const r = validateRenameTarget('', 'self', rows('self', []), new Set())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('empty')
  })

  test('non-kebab-case → invalid', () => {
    const r = validateRenameTarget('Bad Name', 'self', rows('self', []), new Set())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid')
  })

  test('collides with existing DB skill → conflict-with-db', () => {
    const r = validateRenameTarget('taken', 'self', rows('self', []), new Set(['taken']))
    expect(r.reason).toBe('conflict-with-db')
  })

  test('collides with another rename in batch → duplicate-in-batch', () => {
    const r = validateRenameTarget(
      'merged',
      'self',
      rows('self', [['other', 'rename', 'merged']]),
      new Set(),
    )
    expect(r.reason).toBe('duplicate-in-batch')
  })

  test('collides with another row that imports under same name → duplicate-in-batch', () => {
    // 'other' is keeping its own name 'merged'; renaming self → 'merged' must clash
    const r = validateRenameTarget(
      'merged',
      'self',
      rows('self', [['merged', 'import']]),
      new Set(),
    )
    expect(r.reason).toBe('duplicate-in-batch')
  })

  test('valid kebab-case + no clash → ok', () => {
    const r = validateRenameTarget('valid-name', 'self', rows('self', []), new Set())
    expect(r.ok).toBe(true)
  })
})

describe('effectiveTargetName', () => {
  test('import → candidate name', () => {
    const row: RowState = {
      candidate: candidate('a'),
      decision: { action: 'import', newName: '' },
    }
    expect(effectiveTargetName(row)).toBe('a')
  })
  test('skip → null', () => {
    const row: RowState = {
      candidate: candidate('a'),
      decision: { action: 'skip', newName: '' },
    }
    expect(effectiveTargetName(row)).toBeNull()
  })
  test('rename → newName', () => {
    const row: RowState = {
      candidate: candidate('a'),
      decision: { action: 'rename', newName: 'b' },
    }
    expect(effectiveTargetName(row)).toBe('b')
  })
})

describe('buildDecisionMap', () => {
  test('every action shows up with the right shape', () => {
    const rows: RowState[] = [
      {
        candidate: candidate('a'),
        decision: { action: 'import', newName: '' },
      },
      {
        candidate: candidate('b', 'managed'),
        decision: { action: 'overwrite', newName: '' },
      },
      {
        candidate: candidate('c', 'managed'),
        decision: { action: 'rename', newName: 'c-new' },
      },
      {
        candidate: candidate('d', 'managed'),
        decision: { action: 'skip', newName: '' },
      },
    ]
    const map = buildDecisionMap(rows)
    expect(map).toEqual({
      a: { action: 'import' },
      b: { action: 'overwrite' },
      c: { action: 'rename', newName: 'c-new' },
      d: { action: 'skip' },
    })
  })

  test('rename with empty newName is dropped (caller already disabled submit)', () => {
    const rows: RowState[] = [
      {
        candidate: candidate('a'),
        decision: { action: 'rename', newName: '' },
      },
    ]
    expect(buildDecisionMap(rows)).toEqual({})
  })
})

describe('summarizeRows', () => {
  test('counts each action bucket', () => {
    const rows: RowState[] = [
      { candidate: candidate('a'), decision: { action: 'import', newName: '' } },
      { candidate: candidate('b'), decision: { action: 'import', newName: '' } },
      { candidate: candidate('c'), decision: { action: 'overwrite', newName: '' } },
      { candidate: candidate('d'), decision: { action: 'rename', newName: 'x' } },
      { candidate: candidate('e'), decision: { action: 'skip', newName: '' } },
    ]
    expect(summarizeRows(rows)).toEqual({
      importing: 2,
      overwriting: 1,
      renaming: 1,
      skipping: 1,
      total: 5,
    })
  })
})

describe('rowsFromParseResponse', () => {
  test('hydrates each candidate with its initial decision', () => {
    const rows = rowsFromParseResponse({
      skills: [candidate('a'), candidate('b', 'managed'), candidate('c', 'managed')],
      errors: [],
    })
    expect(rows.map((r) => r.decision.action)).toEqual(['import', 'skip', 'skip'])
  })
})

describe('validateSkillZipFile (RFC-196)', () => {
  function archive(name: string, size: number): File {
    return new File([new Uint8Array(size)], name, { type: '' })
  }

  test('accepts case-insensitive .zip names without trusting MIME', () => {
    expect(validateSkillZipFile(archive('skills.ZIP', 1)).ok).toBe(true)
  })

  test('rejects non-zip names', () => {
    expect(validateSkillZipFile(archive('skills.tar.gz', 1))).toEqual({
      ok: false,
      reason: 'type',
    })
  })

  test('accepts exactly the limit and rejects limit + 1', () => {
    const exact = { name: 'skills.zip', size: SKILL_ZIP_LIMITS.totalBytes } as File
    const over = { name: 'skills.zip', size: SKILL_ZIP_LIMITS.totalBytes + 1 } as File
    expect(validateSkillZipFile(exact).ok).toBe(true)
    expect(validateSkillZipFile(over)).toEqual({ ok: false, reason: 'too-large' })
  })
})

describe('deriveReviewSummary (RFC-196)', () => {
  test('counts candidates, conflicts, readonly conflicts, and archive errors', () => {
    expect(
      deriveReviewSummary({
        skills: [
          candidate('ready'),
          candidate('owner', 'managed', true),
          candidate('locked', 'managed'),
        ],
        errors: [{ path: 'bad', code: 'skill-md-missing', message: 'missing' }],
      }),
    ).toEqual({ candidates: 3, conflicts: 2, readonlyConflicts: 1, archiveErrors: 1 })
  })
})

describe('deriveSubmitState (RFC-196)', () => {
  const names = { available: true, names: new Set<string>() }

  test('nothing selected is disabled', () => {
    const rows: RowState[] = [
      { candidate: candidate('a', 'managed'), decision: { action: 'skip', newName: '' } },
    ]
    expect(deriveSubmitState(rows, names, false).reason).toBe('nothing-selected')
  })

  test('invalid rename is disabled', () => {
    const rows: RowState[] = [
      { candidate: candidate('a', 'managed'), decision: { action: 'rename', newName: 'Bad Name' } },
    ]
    expect(deriveSubmitState(rows, names, false).reason).toBe('rename-invalid')
  })

  test('rename waits for an existing-names response', () => {
    const rows: RowState[] = [
      { candidate: candidate('a', 'managed'), decision: { action: 'rename', newName: 'a-new' } },
    ]
    expect(
      deriveSubmitState(rows, { available: false, names: new Set<string>() }, false).reason,
    ).toBe('names-unavailable')
  })

  test('busy state wins and valid import is otherwise enabled', () => {
    const rows: RowState[] = [
      { candidate: candidate('a'), decision: { action: 'import', newName: '' } },
    ]
    expect(deriveSubmitState(rows, names, true).reason).toBe('busy')
    expect(deriveSubmitState(rows, names, false)).toMatchObject({ enabled: true })
  })
})

describe('resultKind (RFC-196)', () => {
  function summary(written: number, failed: number): CommitSkillZipResponse {
    return {
      created: Array.from({ length: written }, (_, i) => ({ name: `s-${i}` })) as never[],
      updated: [],
      skipped: [],
      failed: Array.from({ length: failed }, (_, i) => ({
        name: `f-${i}`,
        code: 'skill-write-failed' as const,
        message: 'failed',
      })),
    }
  }

  test('derives success, partial, and no-write', () => {
    expect(resultKind(summary(1, 0))).toBe('success')
    expect(resultKind(summary(1, 1))).toBe('partial')
    expect(resultKind(summary(0, 1))).toBe('no-write')
    expect(resultKind(summary(0, 0))).toBe('no-write')
  })
})

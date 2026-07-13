// RFC-019: pure helpers driving the ZIP import UI. These are the predicates
// the ImportZipPanel uses to wire submit-disabled, rename validation, and
// the final decisions payload — locking them at unit level is much cheaper
// than driving the whole React tree.

import { describe, expect, test } from 'vitest'
import type { SkillZipCandidateView } from '@agent-workflow/shared'
import {
  availableActionsFor,
  buildDecisionMap,
  effectiveTargetName,
  initialDecisionFor,
  rowsFromParseResponse,
  summarizeRows,
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

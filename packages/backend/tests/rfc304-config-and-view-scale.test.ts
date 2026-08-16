// RFC-304 §11.6/§11.7 (T65/T66) — 200 repositories, and an 80-round merge
// request.
//
// T65's central decision is a REFUSAL: no three-level inheritance. It will be
// proposed again, so the reason is worth pinning in a test. With inheritance,
// "why is this repository doing that?" has no local answer — the cell shows
// nothing, the value lives somewhere the reader has to go find, and it changes
// when somebody edits a level they cannot see. Every support question becomes
// archaeology. So a bulk change is an explicit write to each cell, and "bulk"
// is a property of the tool rather than of the data model.
//
// T66's bounds all exist to prevent the same thing: a list that LOOKS complete
// and is not. A reader who concludes a merge request had 20 rounds when it had
// 80 has been misled by the page, not merely inconvenienced.

import { describe, expect, test } from 'bun:test'
import {
  classifyChange,
  effectiveConfig,
  invertBatch,
  previewBulk,
  type CellChange,
} from '../src/modules/code-capability/domain/configScale'
import {
  ROUND_WINDOW,
  describeHidden,
  roundWindow,
  shouldVirtualise,
  stageMayHaveAttempts,
  VIRTUALISE_THRESHOLD,
} from '../src/modules/code-capability/domain/stateViewScale'

const change = (over: Partial<CellChange> = {}): CellChange => ({
  repoId: 'repo-1',
  capability: 'mr-review',
  before: { enabled: false, bindingId: null },
  after: { enabled: true, bindingId: 'binding-1' },
  ...over,
})

describe('RFC-304 T65 — a bulk edit is explicit writes', () => {
  test('a cell that does not exist yet is a create', () => {
    expect(classifyChange(change({ before: null }))).toBe('create')
  })

  test('a cell already holding the target value is a NO-OP, not an update', () => {
    expect(
      classifyChange(
        change({
          before: { enabled: true, bindingId: 'binding-1' },
          after: { enabled: true, bindingId: 'binding-1' },
        }),
      ),
    ).toBe('no-op')
  })

  test('the preview COUNTS no-ops instead of hiding them', () => {
    // "This will change 12 repositories" reads very differently from "this
    // matched 200, 188 already set" — and the second is what tells the author
    // their selector is wider than they meant, which is the mistake a bulk tool
    // makes easy.
    const preview = previewBulk([
      change({ repoId: 'a', before: null }),
      change({ repoId: 'b' }),
      change({
        repoId: 'c',
        before: { enabled: true, bindingId: 'binding-1' },
        after: { enabled: true, bindingId: 'binding-1' },
      }),
    ])
    expect(preview.creates).toHaveLength(1)
    expect(preview.updates).toHaveLength(1)
    expect(preview.noOps).toHaveLength(1)
    expect(preview.message).toContain('1 already set')
  })

  test('a selector matching nothing says so plainly', () => {
    expect(previewBulk([]).message).toContain('matches nothing')
  })
})

describe('RFC-304 T65 — revert restores exactly what was changed', () => {
  test('the inverse comes from the RECORDED before, not the current state', () => {
    // By the time somebody reverts, other edits may have landed. Re-deriving
    // from the current state would either clobber those or fail; the recorded
    // before restores this batch and nothing else.
    const applied = [change({ repoId: 'a' })]
    const inverse = invertBatch(applied)
    expect(inverse[0]?.after).toEqual({ enabled: false, bindingId: null })
    expect(inverse[0]?.before).toEqual({ enabled: true, bindingId: 'binding-1' })
  })

  test('a created cell reverts by DISABLING, not by deletion', () => {
    // Deleting would also discard the readiness and trigger configuration the
    // create brought along. A revert that destroys more than the thing it
    // reverses is not one.
    const inverse = invertBatch([change({ before: null })])
    expect(inverse[0]?.after).toEqual({ enabled: false, bindingId: null })
  })

  test('no-ops are not inverted — they changed nothing', () => {
    const inverse = invertBatch([
      change({
        before: { enabled: true, bindingId: 'b' },
        after: { enabled: true, bindingId: 'b' },
      }),
    ])
    expect(inverse).toEqual([])
  })
})

describe('RFC-304 T65 — one read model', () => {
  test('the effective config says where its values came from', () => {
    // `source` is a constant today and stated anyway: it is the field that
    // would have to grow values if inheritance were ever added, so the read
    // model would not change shape to say so.
    const cfg = effectiveConfig({
      repoId: 'r',
      capability: 'mr-review',
      enabled: true,
      bindingId: 'b',
    })
    expect(cfg.source).toBe('cell')
  })
})

describe('RFC-304 T66 — the state view is bounded', () => {
  test('a short history is returned whole with nothing hidden', () => {
    const w = roundWindow({ total: 3 })
    expect(w.hasMore).toBe(false)
    expect(w.hidden).toBe(0)
  })

  test('an 80-round item hides the rest and SAYS how many', () => {
    // The failure being prevented: a list that looks complete and is not.
    const w = roundWindow({ total: 80 })
    expect(w.hasMore).toBe(true)
    expect(w.hidden).toBe(80 - ROUND_WINDOW)
    expect(describeHidden(w.hidden)).toContain(String(80 - ROUND_WINDOW))
  })

  test('a caller cannot ask for more than the window', () => {
    // Otherwise the bound is advisory, and the first page that wants "just a
    // few more" removes it for everyone.
    expect(roundWindow({ total: 500, limit: 500 }).limit).toBe(ROUND_WINDOW)
  })

  test('paging to the end reports nothing further hidden', () => {
    const w = roundWindow({ total: 25, offset: 20 })
    expect(w.hasMore).toBe(false)
    expect(describeHidden(w.hidden)).toBeNull()
  })

  test('one hidden round is not written as “1 rounds”', () => {
    expect(describeHidden(1)).toContain('1 earlier round is')
  })

  test('a long list virtualises, a short one does not', () => {
    expect(shouldVirtualise(VIRTUALISE_THRESHOLD + 1)).toBe(true)
    expect(shouldVirtualise(VIRTUALISE_THRESHOLD)).toBe(false)
  })

  test('a program stage is never asked for attempts', () => {
    // It has none by construction; asking is a round trip whose answer is
    // always empty.
    expect(stageMayHaveAttempts('ai')).toBe(true)
    expect(stageMayHaveAttempts('program')).toBe(false)
    expect(stageMayHaveAttempts('script')).toBe(false)
    expect(stageMayHaveAttempts('invoke')).toBe(false)
  })
})

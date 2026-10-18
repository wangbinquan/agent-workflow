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
  ROUND_WINDOW,
  describeHidden,
  roundWindow,
  shouldVirtualise,
  stageMayHaveAttempts,
  VIRTUALISE_THRESHOLD,
} from '../src/modules/code-capability/domain/stateViewScale'

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

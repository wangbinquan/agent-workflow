// LOCKS: the wrapper-fanout shard-source derives the inner node's input port
// kind from the list's ITEM kind via the canonical stringifyKind, NOT a
// hand-rolled per-kind switch.
//
// Bug (same class as the review.ts path<md> drift): scheduler.ts inlined a
// switch that stringified a list item kind by hand — base→name, path→`path<ext>`
// — but dropped a nested list<list<...>> item to a bare 'list', losing the inner
// kind so the runner could not re-parse it. The fix delegates to the canonical
// stringifyKind (kindParser), which round-trips every kind including path<md>
// and nested lists.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringifyKind, tryParseKind } from '@agent-workflow/shared'

const WRAPPER_MECHANICS_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'wrapperMechanics.ts',
  ),
  'utf8',
)

describe('shard-source inner port kind — canonical stringify (no fork)', () => {
  test('wrapper mechanics derives the shard item kind via stringifyKind(lk.item)', () => {
    expect(WRAPPER_MECHANICS_SRC).toContain('stringifyKind(lk.item)')
  })

  test('wrapper mechanics does not hand-roll a path<ext> stringify (must use stringifyKind)', () => {
    // The old fork re-implemented stringifyKind's path branch as a template
    // literal. Its presence means someone reintroduced the drift-prone switch.
    expect(WRAPPER_MECHANICS_SRC).not.toContain('path<${')
  })

  // The behavioral pay-off: stringifyKind(parseKind(K).item) is the value the
  // inner node receives. It must round-trip BOTH the common path<md> item and a
  // nested list item (the old switch returned a bare 'list' for the latter).
  test('canonical derivation round-trips list<path<md>> → path<md>', () => {
    const lk = tryParseKind('list<path<md>>')
    expect(lk?.kind).toBe('list')
    expect(stringifyKind((lk as { item: Parameters<typeof stringifyKind>[0] }).item)).toBe(
      'path<md>',
    )
  })

  test('canonical derivation round-trips nested list<list<string>> → list<string> (old switch dropped to "list")', () => {
    const lk = tryParseKind('list<list<string>>')
    expect(lk?.kind).toBe('list')
    expect(stringifyKind((lk as { item: Parameters<typeof stringifyKind>[0] }).item)).toBe(
      'list<string>',
    )
  })
})

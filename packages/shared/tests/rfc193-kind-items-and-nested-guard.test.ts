// RFC-193 T2 — locks two shared-layer contracts introduced by the
// archive-at-emit design (design.md §4.2 / D18):
//
//  1. ListHandler.validate now returns per-item `items` (body + sourcePath,
//     in splitListItems line order) so the runner's archival pass can reuse
//     the validation pass's file reads. Single-value kinds never set items.
//  2. Nested list kinds carrying a path (list<list<path<md>>>) are REJECTED
//     at declaration (AgentOutputKindSchema) — the archival / force-include
//     machinery is single-level, so such ports would validate yet dangle.
//
// Why this file exists: without lock 1 the runner would silently re-read (or
// worse, skip) list item files at archive time; without lock 2 a legal-looking
// agent declaration would bypass RFC-193's whole reading-semantics guarantee.

import { describe, expect, test } from 'bun:test'
import { parseKind, isNestedListPathKind, isNestedListPathKindString } from '../src/kindParser'
import { getHandlerForParsedKind } from '../src/outputKinds/registry'
import type { ValidateIO } from '../src/outputKinds/types'
import { AgentOutputKindSchema } from '../src/schemas/review'

function makeIO(fs: Record<string, string>): ValidateIO {
  return {
    resolveWorktreePath(worktreeAbsPath, rawContent) {
      const rel = rawContent.trim()
      const inside = !rel.startsWith('/') && !rel.split('/').includes('..')
      const targetAbs = `${worktreeAbsPath}/${rel}`
      return { targetAbs, relativePath: rel, insideWorktree: inside }
    },
    readFileUtf8(absPath) {
      if (!(absPath in fs)) {
        throw new Error(`ENOENT: no such file or directory '${absPath}'`)
      }
      return fs[absPath]!
    },
  }
}

describe('RFC-193 ListHandler.validate items', () => {
  const wt = '/tmp/wt'
  const io = makeIO({
    '/tmp/wt/a.md': 'A body',
    '/tmp/wt/sub/b.md': 'B body',
  })

  test('list<path<md>> returns items in splitListItems line order with sourcePath', () => {
    const h = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const r = h.validate(
      'a.md\n\nsub/b.md\n',
      { port: 'p', kind: parseKind('list<path<md>>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toEqual([
        { body: 'A body', sourcePath: 'a.md' },
        { body: 'B body', sourcePath: 'sub/b.md' },
      ])
    }
  })

  test('list<string> returns items without sourcePath', () => {
    const h = getHandlerForParsedKind(parseKind('list<string>'))
    const r = h.validate(
      'alpha\nbeta',
      { port: 'p', kind: parseKind('list<string>'), worktreePath: wt },
      io,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toEqual([{ body: 'alpha' }, { body: 'beta' }])
    }
  })

  test('empty list → ok with empty body and no items entries', () => {
    const h = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const r = h.validate('', { port: 'p', kind: parseKind('list<path<md>>'), worktreePath: wt }, io)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.items ?? []).toEqual([])
  })

  test('single-value path<md> does NOT set items', () => {
    const h = getHandlerForParsedKind(parseKind('path<md>'))
    const r = h.validate('a.md', { port: 'p', kind: parseKind('path<md>'), worktreePath: wt }, io)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.items).toBeUndefined()
  })
})

describe('RFC-193 D18 nested-list-path guard', () => {
  test('predicate: nested list containing path → true', () => {
    expect(isNestedListPathKind(parseKind('list<list<path<md>>>'))).toBe(true)
    expect(isNestedListPathKind(parseKind('list<list<list<path<*>>>>'))).toBe(true)
    expect(isNestedListPathKindString('list<list<path<markdown>>>')).toBe(true)
  })

  test('predicate: single-level list / non-path nesting → false', () => {
    expect(isNestedListPathKind(parseKind('list<path<md>>'))).toBe(false)
    expect(isNestedListPathKind(parseKind('list<list<string>>'))).toBe(false)
    expect(isNestedListPathKind(parseKind('path<md>'))).toBe(false)
    expect(isNestedListPathKindString('not a kind')).toBe(false)
  })

  test('AgentOutputKindSchema rejects nested list path with the D18 code', () => {
    const res = AgentOutputKindSchema.safeParse('list<list<path<md>>>')
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues[0]?.message).toContain('output-kind-nested-list-path-unsupported')
    }
  })

  test('AgentOutputKindSchema keeps accepting single-level list<path<md>> and markdown_file', () => {
    expect(AgentOutputKindSchema.safeParse('list<path<md>>').success).toBe(true)
    expect(AgentOutputKindSchema.safeParse('markdown_file').success).toBe(true)
    expect(AgentOutputKindSchema.safeParse('list<list<string>>').success).toBe(true)
  })
})

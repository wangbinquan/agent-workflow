// RFC-049 PR-A — locks in that `buildProtocolBlock` now iterates the
// registered OutputKindHandler set for prompt-side guidance instead of
// hard-coding markdown_file branches inline.
//
// The protocol-test suite already covers the EXTERNAL behavior (output
// matches the legacy text). This file locks the INTERNAL contract that the
// guidance text now comes from handlers, which is what makes future kind
// additions a one-file change.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildProtocolBlock } from '@agent-workflow/shared'

const PROMPT_SRC = readFileSync(join(import.meta.dir, '../src/prompt.ts'), 'utf8')

describe('RFC-049 buildProtocolBlock — handler dispatch', () => {
  test('declares only string/markdown → no markdown_file guidance appears', () => {
    const block = buildProtocolBlock(['a', 'b'], { a: 'string', b: 'markdown' })
    expect(block).not.toContain('For ports declared `markdown_file` above')
    expect(block).not.toContain('USE A FILE-WRITING TOOL')
    expect(block).not.toContain('two-step protocol')
  })

  test('declares a markdown_file port → path<md> handler contributes file-first guidance', () => {
    // RFC-080: buildProtocolBlock now dispatches via the parametric registry.
    // 'markdown_file' folds to path<md> at parse time, so the PATH handler's
    // two-step guidance is emitted (text differs from the legacy markdownFile
    // handler but is semantically equivalent — D1).
    const block = buildProtocolBlock(['report'], { report: 'markdown_file' })
    expect(block).toContain('For path-kind ports above')
    expect(block).toContain('`report` (extension .md/.markdown)')
    expect(block).toContain('USE A FILE-WRITING TOOL')
    expect(block).toContain('two-step protocol')
  })

  test('zero outputKinds map → equivalent to all-string (no kind-specific guidance)', () => {
    const block = buildProtocolBlock(['summary'])
    expect(block).not.toContain('For ports declared `markdown_file` above')
    expect(block).not.toContain('USE A FILE-WRITING TOOL')
    // The bare bullet for string ports still renders.
    expect(block).toContain('  - summary\n')
  })
})

describe('RFC-049 shared/prompt.ts source-level migration anchors', () => {
  test('legacy private helper buildMarkdownFilePortGuidance has been removed from shared/prompt.ts', () => {
    // Old text helper moved into outputKinds/markdownFile.ts; nothing in
    // shared/prompt.ts should still hold the markdown_file-specific prompt
    // strings as literals. (Brief mentions in comments referencing the
    // handler dispatch are fine — what we lock here is that the emitted
    // prompt text no longer originates from shared/prompt.ts.)
    expect(PROMPT_SRC).not.toContain('function buildMarkdownFilePortGuidance')
    expect(PROMPT_SRC).not.toContain('USE A FILE-WRITING TOOL')
    expect(PROMPT_SRC).not.toContain('write the file first, then place ONLY')
  })

  test('shared/prompt.ts now imports from the parametric handler registry', () => {
    // RFC-080: migrated from the legacy `groupPortsByKind` (3-key Record) to
    // the parametric `groupPortsByParsedKind` (parseKind → matches dispatch).
    expect(PROMPT_SRC).toContain("from './outputKinds'")
    expect(PROMPT_SRC).toContain('groupPortsByParsedKind')
    expect(PROMPT_SRC).toContain('buildPromptGuidance')
    // The legacy 3-key grouping helper must no longer be referenced here.
    expect(PROMPT_SRC).not.toContain('groupPortsByKind(')
  })
})

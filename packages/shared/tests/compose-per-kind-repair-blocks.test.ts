// RFC-049 — composePerKindRepairBlocks helper. The bridge between the failure
// payload runner persists into port_validation_failures_json and the
// `perKindRepairBlocks` string array shared/prompt.ts splices into the
// follow-up prompt.

import { describe, expect, test } from 'bun:test'

import { composePerKindRepairBlocks } from '@agent-workflow/shared'

describe('RFC-049 composePerKindRepairBlocks', () => {
  test('empty failures → empty array (no repair section at all)', () => {
    expect(composePerKindRepairBlocks([])).toEqual([])
    expect(composePerKindRepairBlocks([], { docpath: 'markdown_file' })).toEqual([])
  })

  test('single markdown_file failure → single segment with handler section header', () => {
    const blocks = composePerKindRepairBlocks(
      [
        {
          port: 'docpath',
          kind: 'markdown_file',
          subReason: 'missing-file',
          detail: "markdown_file 'docpath.md': ENOENT",
        },
      ],
      { docpath: 'markdown_file' },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!).toContain('**Port content validation — markdown_file.**')
    expect(blocks[0]!).toContain('- port `docpath`: file at the given path does not exist.')
    expect(blocks[0]!).toContain('two-step protocol')
  })

  test('multiple failures same kind → bucketed into one segment, ordering preserved', () => {
    const blocks = composePerKindRepairBlocks(
      [
        { port: 'a', kind: 'markdown_file', subReason: 'empty-path' },
        { port: 'b', kind: 'markdown_file', subReason: 'missing-file', detail: 'gone' },
      ],
      { a: 'markdown_file', b: 'markdown_file' },
    )
    expect(blocks).toHaveLength(1)
    const idxA = blocks[0]!.indexOf('port `a`')
    const idxB = blocks[0]!.indexOf('port `b`')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
  })

  test('failures for a kind with no registered handler → silently dropped (degraded)', () => {
    // Defensive — the column may have been written by a future runner whose
    // kind set includes something the current build doesn't know about.
    // Renderer falls back to "no repair text" rather than blowing up.
    const blocks = composePerKindRepairBlocks(
      [
        { port: 'a', kind: 'code_file' as never, subReason: 'lint-failed' },
        {
          port: 'b',
          kind: 'markdown_file',
          subReason: 'missing-file',
          detail: 'real failure',
        },
      ],
      { a: 'markdown_file' as never, b: 'markdown_file' },
    )
    // Only markdown_file segment survives.
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!).toContain('Port content validation — markdown_file.')
    expect(blocks[0]!).not.toContain('code_file')
  })

  test('handler returning null → no segment in output', () => {
    // string / markdown handlers always return null even when fed failures.
    const blocks = composePerKindRepairBlocks(
      [
        { port: 'a', kind: 'string', subReason: 'whatever' },
        { port: 'b', kind: 'markdown', subReason: 'whatever' },
      ],
      { a: 'string', b: 'markdown' },
    )
    expect(blocks).toEqual([])
  })

  test('handler receives only its own kind ports in `ports` arg', () => {
    // We can't directly intercept the handler call without monkey-patching,
    // but the rendered text references the kind-specific ports list. Confirm
    // a multi-kind agent only names the markdown_file ports in the
    // markdown_file segment's "you MUST follow..." reminder.
    const blocks = composePerKindRepairBlocks(
      [{ port: 'docpath', kind: 'markdown_file', subReason: 'missing-file' }],
      {
        docpath: 'markdown_file',
        summary: 'string', // sibling port — must NOT appear in markdown_file segment
        notes: 'markdown', // sibling port — must NOT appear
      },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!).toContain('For ports declared `markdown_file` (`docpath`)')
    expect(blocks[0]!).not.toContain('`summary`')
    expect(blocks[0]!).not.toContain('`notes`')
  })
})

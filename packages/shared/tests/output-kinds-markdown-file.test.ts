// RFC-049 PR-A — `markdown_file` kind handler contract.
//
// What's locked:
//   - buildPromptGuidance content (search anchors copied from the original
//     buildMarkdownFilePortGuidance helper in shared/prompt.ts — this handler
//     is the migration target, so the protocol test in backend continues to
//     pass on the re-exported text).
//   - validate produces 3 subReasons in PR-A (empty-path / escapes-worktree
//     / missing-file) via the injected ValidateIO; the file-system work
//     itself stays in backend.
//   - buildRepairBlock renders a fully-formed per-kind segment with section
//     header marker, one bullet per failure, and the two-step reminder.
//
// PR-B will add `wrong-extension` + `empty-file` to both validate and the
// SUB_REASON_DESCRIPTIONS map; PR-A keeps the handler's subReasons set to
// the 3 codes validate actually emits.

import { describe, expect, test } from 'bun:test'

import { markdownFileHandler, type ValidateIO } from '@agent-workflow/shared'

const CTX = { kind: 'markdown_file' as const, port: 'docpath', worktreePath: '/wt' }

function ioWith(opts: { inside?: boolean; body?: string; throwOnRead?: Error }): ValidateIO {
  return {
    resolveWorktreePath: (root, raw) => ({
      targetAbs: `${root}/${raw}`,
      relativePath: raw,
      insideWorktree: opts.inside ?? true,
    }),
    readFileUtf8: () => {
      if (opts.throwOnRead) throw opts.throwOnRead
      return opts.body ?? ''
    },
  }
}

describe('RFC-049 markdown_file kind handler — buildPromptGuidance', () => {
  test('returns null when no markdown_file ports are declared', () => {
    expect(markdownFileHandler.buildPromptGuidance({ ports: [] })).toBeNull()
  })

  test('emits the two-step protocol text naming the supplied ports', () => {
    const text = markdownFileHandler.buildPromptGuidance({ ports: ['report', 'plan'] })
    expect(text).not.toBeNull()
    expect(text!).toContain('For ports declared `markdown_file` above (`report`, `plan`)')
    expect(text!).toContain('USE A FILE-WRITING TOOL')
    expect(text!).toContain(
      'place ONLY that worktree-relative path inside the matching `<port>` tag',
    )
    expect(text!).toContain('a path that does not point to an existing file causes the run to fail')
  })
})

describe('RFC-049 markdown_file kind handler — validate', () => {
  test('happy path: returns body + relative sourcePath when read succeeds', () => {
    const io = ioWith({ inside: true, body: '# Spec\nbody' })
    const r = markdownFileHandler.validate('design/spec.md', CTX, io)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toBe('# Spec\nbody')
      expect(r.sourcePath).toBe('design/spec.md')
    }
  })

  test('empty-path: rawContent trims to empty', () => {
    for (const input of ['', '   ', '\n\n']) {
      const r = markdownFileHandler.validate(input, CTX, ioWith({}))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.subReason).toBe('empty-path')
        expect(r.detail).toContain('empty string')
      }
    }
  })

  test('escapes-worktree: io reports the target lands outside', () => {
    const io = ioWith({ inside: false })
    const r = markdownFileHandler.validate('../etc/passwd', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.subReason).toBe('escapes-worktree')
      expect(r.detail).toContain('outside the task worktree')
      expect(r.detail).toContain("'../etc/passwd'")
    }
  })

  test('missing-file: readFileUtf8 throws → subReason missing-file with err.message detail', () => {
    const io = ioWith({ inside: true, throwOnRead: new Error('ENOENT: no such file or directory') })
    const r = markdownFileHandler.validate('does-not-exist.md', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.subReason).toBe('missing-file')
      expect(r.detail).toContain('ENOENT')
      expect(r.detail).toContain("'does-not-exist.md'")
    }
  })

  test('subReasons set covers exactly the 5 codes validate produces in PR-B', () => {
    expect([...markdownFileHandler.subReasons].sort()).toEqual(
      ['empty-path', 'escapes-worktree', 'missing-file', 'wrong-extension', 'empty-file'].sort(),
    )
  })

  test('wrong-extension: path does not end with .md or .markdown', () => {
    const io = ioWith({ inside: true, body: 'never read' })
    const r = markdownFileHandler.validate('docs/report.txt', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.subReason).toBe('wrong-extension')
      expect(r.detail).toContain('.md or .markdown')
      expect(r.detail).toContain("'docs/report.txt'")
    }
  })

  test('wrong-extension: bare path with no extension', () => {
    const io = ioWith({ inside: true })
    const r = markdownFileHandler.validate('README', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('wrong-extension')
  })

  test('extension check is case-insensitive (.MD / .Markdown both accepted)', () => {
    const io = ioWith({ inside: true, body: '# upper' })
    const upper = markdownFileHandler.validate('docs/REPORT.MD', CTX, io)
    expect(upper.ok).toBe(true)
    const mixedMarkdown = markdownFileHandler.validate('docs/notes.Markdown', CTX, io)
    expect(mixedMarkdown.ok).toBe(true)
  })

  test('empty-file: file exists, extension is .md, but content trims to empty', () => {
    const io = ioWith({ inside: true, body: '   \n\n   ' })
    const r = markdownFileHandler.validate('docs/empty.md', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.subReason).toBe('empty-file')
      expect(r.detail).toContain('empty after trim')
      expect(r.detail).toContain("'docs/empty.md'")
    }
  })

  test('wrong-extension precedes missing-file: .txt path that does not exist still reports wrong-extension', () => {
    // Order matters — the extension check runs BEFORE the read attempt so the
    // agent gets a precise diagnosis instead of a misleading "missing file"
    // when the real bug is a typo'd extension.
    const io = ioWith({
      inside: true,
      throwOnRead: new Error('ENOENT: would have thrown but the read never happens'),
    })
    const r = markdownFileHandler.validate('docs/report.txt', CTX, io)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.subReason).toBe('wrong-extension')
  })
})

describe('RFC-049 markdown_file kind handler — buildRepairBlock', () => {
  test('returns null when failures array is empty', () => {
    expect(markdownFileHandler.buildRepairBlock({ failures: [], ports: ['docpath'] })).toBeNull()
  })

  test('renders one bullet per failure with descriptions and detail tails', () => {
    const text = markdownFileHandler.buildRepairBlock({
      failures: [
        {
          port: 'docpath',
          kind: 'markdown_file',
          subReason: 'missing-file',
          detail: "markdown_file 'report.md': ENOENT: no such file",
        },
        {
          port: 'plan',
          kind: 'markdown_file',
          subReason: 'empty-path',
        },
      ],
      ports: ['docpath', 'plan'],
    })
    expect(text).not.toBeNull()
    expect(text!).toContain('**Port content validation — markdown_file.**')
    expect(text!).toMatch(/- port `docpath`: file at the given path does not exist\./)
    expect(text!).toContain("markdown_file 'report.md': ENOENT")
    expect(text!).toMatch(/- port `plan`: empty path\./)
    // Two-step reminder names every markdown_file port on the agent.
    expect(text!).toContain('For ports declared `markdown_file` (`docpath`, `plan`)')
    expect(text!).toContain('write the file to disk first')
  })

  test('preserves first-occurrence order of multiple failures', () => {
    const text = markdownFileHandler.buildRepairBlock({
      failures: [
        { port: 'b', kind: 'markdown_file', subReason: 'empty-path' },
        { port: 'a', kind: 'markdown_file', subReason: 'missing-file', detail: 'gone' },
      ],
      ports: ['a', 'b'],
    })
    const idxA = text!.indexOf('port `a`')
    const idxB = text!.indexOf('port `b`')
    // 'b' was first in failures, so its bullet must come first.
    expect(idxB).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(idxB)
  })

  test('describes pre-declared PR-B subReasons even without validators wired', () => {
    // PR-B will add 'wrong-extension' / 'empty-file' to validate; in PR-A,
    // buildRepairBlock already knows how to describe them so PR-B doesn't
    // have to re-touch this file for shared text — only to flip subReasons
    // and the validate switch.
    const text = markdownFileHandler.buildRepairBlock({
      failures: [
        { port: 'p1', kind: 'markdown_file', subReason: 'wrong-extension' },
        { port: 'p2', kind: 'markdown_file', subReason: 'empty-file' },
      ],
      ports: ['p1', 'p2'],
    })
    expect(text!).toContain('path extension is not .md / .markdown')
    expect(text!).toContain('file exists but its content is empty after trim')
  })
})

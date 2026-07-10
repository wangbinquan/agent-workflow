import { rimrafDir } from './helpers/cleanup'
// RFC-049 PR-B — direct contract test for `kind === undefined` raw passthrough.
//
// The forgiveness path that used to auto-promote single-line .md paths into
// file reads is gone. The exposed contract now is: when a port's outputKinds
// entry is absent, the framework returns rawContent verbatim. No probe, no
// fs touch, no path resolution — even for inputs that look like worktree-
// relative paths to real files.
//
// If these go red, see resolvePortContentDetailed: it should be a single
// early-return passthrough for kind === undefined.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContent, resolvePortContentDetailed } from '../src/services/envelope'

describe('RFC-049 PR-B kind=undefined raw passthrough contract', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-rawpt-'))
  })

  afterEach(() => {
    rimrafDir(worktree)
  })

  test('rawContent looks like a relative .md path AND the file exists → still passthrough', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# would-be body')
    const out = resolvePortContent({ rawContent: 'docs/design.md', worktreePath: worktree })
    // Pre-PR-B this would have returned '# would-be body' via forgiveness;
    // post-PR-B the only path to get the body delivered is to declare
    // outputKinds.<port> = 'markdown_file' explicitly on the agent.
    expect(out).toBe('docs/design.md')
  })

  test('rawContent is an arbitrary string → returned verbatim', () => {
    const out = resolvePortContent({ rawContent: 'just a status update', worktreePath: worktree })
    expect(out).toBe('just a status update')
  })

  test('resolvePortContentDetailed reports no sourcePath in the passthrough case', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), 'never read')
    const r = resolvePortContentDetailed({
      rawContent: 'docs/design.md',
      worktreePath: worktree,
    })
    expect(r.body).toBe('docs/design.md')
    expect(r.sourcePath).toBeUndefined()
  })
})

// RFC-083 — git-wrapper scope: a wrapper-git node's structural diff is computed
// against its recorded baseline commit (the HEAD captured before its inner
// scope, stored in node_runs.wrapper_progress_json). This locks the baseline
// extraction; the compute itself reuses computeFromWorktree (tested elsewhere).

import { describe, expect, test } from 'bun:test'
import { parseWrapperGitBaseline } from '../src/modules/workspace-insight/application/structuralDiff/taskStructuralDiff'

describe('parseWrapperGitBaseline', () => {
  test('git wrapper with a baseline commit → the commit', () => {
    const json = JSON.stringify({ kind: 'git', baseline: 'abc123def', phase: 'awaiting' })
    expect(parseWrapperGitBaseline(json)).toBe('abc123def')
  })

  test('loop wrapper → null (not a git wrapper)', () => {
    const json = JSON.stringify({ kind: 'loop', iteration: 2, phase: 'awaiting' })
    expect(parseWrapperGitBaseline(json)).toBeNull()
  })

  test('git wrapper with empty baseline → null', () => {
    const json = JSON.stringify({ kind: 'git', baseline: '', phase: 'inner-running' })
    expect(parseWrapperGitBaseline(json)).toBeNull()
  })

  test('null / malformed JSON → null (never throws)', () => {
    expect(parseWrapperGitBaseline(null)).toBeNull()
    expect(parseWrapperGitBaseline('')).toBeNull()
    expect(parseWrapperGitBaseline('{not json')).toBeNull()
    expect(parseWrapperGitBaseline('{"kind":"git"}')).toBeNull() // no phase → schema fails
  })
})

// RFC-187 §4 (audit design/workgroup-e2e-audit.md §4, new finding) — probe A: a fan-out
// where both writers wrote to the LEADER's iso via an absolute path baked into the briefs;
// their own isos stayed empty → merge-back merged nothing → canonical empty but the task
// reported `done`. Silent zero-delta success with no guard. Fix: detect done-with-zero-
// canonical-delta and post a non-blocking warn, plus tell the leader (protocol) to brief
// RELATIVE paths so workers write inside their own worktree.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detectZeroDeltaDone } from '../src/services/workgroupRunner'

describe('RFC-187 §4 — detectZeroDeltaDone', () => {
  test('zero files + completed work = suspect (probe A shape)', () => {
    expect(detectZeroDeltaDone(0, 1)).toBe(true)
    expect(detectZeroDeltaDone(0, 3)).toBe(true)
  })

  test('zero files + NO completed work = not suspect (nothing was expected)', () => {
    expect(detectZeroDeltaDone(0, 0)).toBe(false)
  })

  test('files changed = not suspect (outputs merged)', () => {
    expect(detectZeroDeltaDone(1, 1)).toBe(false)
    expect(detectZeroDeltaDone(5, 3)).toBe(false)
  })
})

describe('RFC-187 §4 — source locks', () => {
  test('the leader protocol tells briefs to use relative, not absolute, paths', () => {
    const ctx = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroupContext.ts'),
      'utf8',
    )
    expect(ctx).toContain('RELATIVE path')
    expect(ctx).toMatch(/never[\s\S]{0,40}absolute path/)
  })

  test('the engine wires a zero-delta warn on done (both the gated and un-gated finish)', () => {
    const runner = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
      'utf8',
    )
    // called before BOTH `return { kind: 'ok' }` sites (autonomous done + gate-approved done).
    const calls = runner.split('await warnIfZeroDeltaDone(args, state)').length - 1
    expect(calls).toBeGreaterThanOrEqual(2)
    // the canonical-diff hook is provided by scheduler, not the engine.
    const scheduler = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(scheduler).toContain('getCanonicalFilesChanged')
  })

  // Codex impl-gate P1 — the hook used to diff `task.worktreePath`, which for a MULTI-REPO
  // task is a non-git parent container: git threw, warnIfZeroDeltaDone swallowed it, and
  // the warning silently never fired for multi-repo tasks at all. It must diff EVERY repo
  // at its own worktree/base.
  test('the hook sums the delta per-repo (not the non-git multi-repo parent container)', () => {
    const scheduler = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // per-repo worktree+base, not the task-level parent.
    expect(scheduler).toContain('worktreeFilesChanged(r.worktreePath, r.baseCommit as string)')
    expect(scheduler).not.toContain('worktreeFilesChanged(task.worktreePath, task.baseCommit)')
    // and SchedulerState.repos carries the per-repo base that makes it possible.
    expect(scheduler).toContain('baseCommit: string | null')
    expect(scheduler).toContain('state.repos.filter((r) => r.baseCommit !== null)')
  })
})

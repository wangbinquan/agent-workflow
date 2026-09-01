// RFC-187 §4 (audit design/workgroup-e2e-audit.md §4, new finding) — probe A: a fan-out
// where both writers wrote to the LEADER's iso via an absolute path baked into the briefs;
// their own isos stayed empty → merge-back merged nothing → canonical empty but the task
// reported `done`. Silent zero-delta success with no guard. Fix: detect done-with-zero-
// canonical-delta and post a non-blocking warn, plus tell the leader (protocol) to brief
// RELATIVE paths so workers write inside their own worktree.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  detectZeroDeltaDone,
  warnIfZeroDeltaDone,
} from '../src/modules/resource-catalog/infrastructure/legacy/workgroup/strategies/leaderWorker'

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
  test('RFC-274 discussion output skips the hook before any git work; files preserves it', async () => {
    let calls = 0
    const args = {
      hooks: {
        getCanonicalFilesChanged: async () => {
          calls += 1
          return 1
        },
      },
    }
    const state = {
      config: { mode: 'leader_worker', outputContract: 'discussion' },
      assignments: [{ status: 'done' }],
    }
    await warnIfZeroDeltaDone(args as never, state as never)
    expect(calls).toBe(0)

    state.config.outputContract = 'files'
    await warnIfZeroDeltaDone(args as never, state as never)
    expect(calls).toBe(1)
  })

  test('the leader protocol tells briefs to use relative, not absolute, paths', () => {
    const ctx = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'workgroup',
        'context.ts',
      ),
      'utf8',
    )
    expect(ctx).toContain('RELATIVE path')
    expect(ctx).toMatch(/never[\s\S]{0,40}absolute path/)
  })

  test('the engine wires a zero-delta warn on done (both the gated and un-gated finish)', () => {
    const runner = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'workgroup',
        'engine.ts',
      ),
      'utf8',
    )
    // called before BOTH `return { kind: 'ok' }` sites (autonomous done + gate-approved done).
    const calls = runner.split('await warnIfZeroDeltaDone(args, state)').length - 1
    expect(calls).toBeGreaterThanOrEqual(2)
    // The canonical-diff hook is provided by task-execution node mechanics, not the engine.
    const nodeMechanics = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    expect(nodeMechanics).toContain('getCanonicalFilesChanged')
  })

  // Codex impl-gate P1 — the hook used to diff `task.worktreePath`, which for a MULTI-REPO
  // task is a non-git parent container: git threw, warnIfZeroDeltaDone swallowed it, and
  // the warning silently never fired for multi-repo tasks at all. It must diff EVERY repo
  // at its own worktree/base.
  test('the hook sums the delta per-repo (not the non-git multi-repo parent container)', () => {
    const nodeMechanics = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // per-repo worktree+base, not the task-level parent.
    expect(nodeMechanics).toContain('worktreeFilesChanged(r.worktreePath, r.baseCommit as string)')
    expect(nodeMechanics).not.toContain('worktreeFilesChanged(task.worktreePath, task.baseCommit)')
    // and SchedulerState.repos carries the per-repo base that makes it possible.
    const mechanicsState = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'execution', 'taskMechanicsState.ts'),
      'utf8',
    )
    expect(mechanicsState).toContain('readonly baseCommit: string | null')
    expect(nodeMechanics).toContain('state.repos.filter((r) => r.baseCommit !== null)')
  })
})

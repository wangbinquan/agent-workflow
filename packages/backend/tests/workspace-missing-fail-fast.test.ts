// 2026-08-04 incident regression locks (Linux deployment, claude-code protocol).
//
// A task row whose canonical worktree pointed into the EPHEMERAL iso/ space
// (`~/.agent-workflow/iso/{taskId}/{nodeRunId}` — cleaned after runs) kept
// dispatching: `createNodeIso` classified the DEAD path as "not a git repo",
// took the mock-harness passthrough, and handed it to the runner as spawn cwd.
// Bun then reported `ENOENT ... posix_spawn '/usr/bin/bwrap'` — naming the
// SANDBOX WRAPPER, not the missing directory — and the per-node retry loop
// turned that into a ~1.4s/attempt failure storm (fresh containment admission
// each time, generation 4→5→6→7 in the daemon log).
//
// Locks:
//  (a) createNodeIso THROWS CanonicalWorktreeMissingError for a missing
//      canonical worktree (ANY repo, not just the primary) — failing the node
//      once at iso-setup time, BEFORE the retry loop / admission / spawn (the
//      scheduler catches it at its createIsoUnderLock sites → 'iso-setup-failed'
//      outside the retry loop).
//  (b) the mock-harness passthrough (dir EXISTS but is not a git repo) stays.
//  (c) repo-less tasks (empty canonRepos) keep passthrough.
//  (d) source-level: the runner / runtimeSmoke / systemAgentRun spawn catches
//      route through explainSpawnEnoent, so a refactor cannot silently bring
//      back the misleading-ENOENT blame on the sandbox wrapper.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CanonicalWorktreeMissingError, createNodeIso } from '../src/services/nodeIsolation'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aw-workspace-missing-'))
}

describe('createNodeIso — missing canonical worktree fails fast (2026-08-04 incident)', () => {
  test('a canonical worktree path that does not exist throws CanonicalWorktreeMissingError', async () => {
    const root = tempRoot()
    const deadPath = join(root, 'iso', '01TASK', '01RUN') // never created
    let thrown: unknown
    try {
      await createNodeIso({
        appHome: join(root, 'app-home'),
        taskId: 't1',
        nodeRunId: 'r1',
        canonRepos: [
          { repoPath: deadPath, worktreePath: deadPath, worktreeDirName: '', baseBranch: 'main' },
        ],
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CanonicalWorktreeMissingError)
    const err = thrown as CanonicalWorktreeMissingError
    expect(err.code).toBe('workspace-missing')
    expect(err.worktreePath).toBe(deadPath)
    expect(err.message).toContain('workspace-missing')
    expect(err.message).toContain(deadPath)
  })

  test('EVERY repo is probed — a missing secondary repo throws naming that path', async () => {
    const root = tempRoot()
    const existingNonGit = join(root, 'repo-a')
    mkdirSync(existingNonGit, { recursive: true })
    const missingSecondary = join(root, 'repo-b-gone')
    let thrown: unknown
    try {
      await createNodeIso({
        appHome: join(root, 'app-home'),
        taskId: 't1',
        nodeRunId: 'r1',
        canonRepos: [
          {
            repoPath: existingNonGit,
            worktreePath: existingNonGit,
            worktreeDirName: 'a',
            baseBranch: 'main',
          },
          {
            repoPath: missingSecondary,
            worktreePath: missingSecondary,
            worktreeDirName: 'b',
            baseBranch: 'main',
          },
        ],
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CanonicalWorktreeMissingError)
    expect((thrown as CanonicalWorktreeMissingError).worktreePath).toBe(missingSecondary)
  })

  test('mock-harness door stays open: an EXISTING non-git dir still passthroughs', async () => {
    const root = tempRoot()
    const plainDir = join(root, 'plain-worktree')
    mkdirSync(plainDir, { recursive: true })
    const handle = await createNodeIso({
      appHome: join(root, 'app-home'),
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos: [
        { repoPath: plainDir, worktreePath: plainDir, worktreeDirName: '', baseBranch: 'main' },
      ],
    })
    expect(handle.passthrough).toBe(true)
    expect(handle.repos[0]?.isoWorktreePath).toBe(plainDir)
  })

  test('repo-less tasks (empty canonRepos) keep passthrough', async () => {
    const root = tempRoot()
    const handle = await createNodeIso({
      appHome: join(root, 'app-home'),
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos: [],
    })
    expect(handle.passthrough).toBe(true)
    expect(handle.repos).toEqual([])
  })
})

describe('spawn catches route through explainSpawnEnoent (source-level wiring locks)', () => {
  const src = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

  test('runner.ts translates the business-spawn ENOENT', () => {
    expect(src('services/runner.ts')).toContain('explainSpawnEnoent(')
  })

  test('runtimeSmoke.ts surfaces the executor-translated probe-spawn ENOENT', () => {
    // RFC-280 T4: the probe spawns through the unified executor, whose
    // managedProcess core owns the ENOENT translation; the smoke result must
    // still carry it (spawnError → detail), so lock both halves of the wiring.
    expect(src('services/execution/managedProcess.ts')).toContain('explainSpawnEnoent(')
    expect(src('services/runtimeSmoke.ts')).toContain('run.spawnError')
  })

  test('systemAgentRun.ts translates the system-spawn ENOENT', () => {
    expect(src('services/systemAgentRun.ts')).toContain('explainSpawnEnoent(')
  })
})

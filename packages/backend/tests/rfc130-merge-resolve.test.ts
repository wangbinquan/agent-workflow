import { rimrafDir } from './helpers/cleanup'
// RFC-130 §6.2 — merge-agent conflict-resolution git orchestration
// (services/nodeIsolation.resolveConflictWithAgent), against real temp git repos
// with a MOCK injected agent. Locks the two outcomes that matter:
//   - agent removes the markers → framework confirms resolution, materializes it
//     into the canonical worktree, and discards the resolve-iso (§6.2④⑤).
//   - agent leaves the conflict → framework does NOT materialize markers into
//     canon (canon stays clean for sibling merge-backs, D27), keeps the
//     resolve-iso for the human, and reports unresolved (§6.3).
// The agent is injected as a plain callback so this git-only orchestration needs
// no scheduler/opencode — the same seam the scheduler wires runNode into (PR-B).

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitTree, mergeTreeInMemory, runGit, snapshotFullState } from '../src/util/git'
import {
  completeHumanResolvedConflict,
  type IsoHandle,
  type MergeBackConflict,
  resolveConflictWithAgent,
} from '../src/services/nodeIsolation'

async function initRepo(seed: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc130-mr-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, c] of Object.entries(seed)) writeFileSync(join(dir, p), c)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
async function head(dir: string): Promise<string> {
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

/**
 * Build a real content conflict on f.txt and return the MergeBackConflict the
 * scheduler would hand to resolveConflictWithAgent, leaving `canon` in its
 * "ours" working state (as merge-back sees it).
 */
async function makeConflict(): Promise<{
  canon: string
  conflict: MergeBackConflict
  theirs: string
}> {
  const canon = await initRepo({ 'f.txt': 'L1\nL2\nL3\n' })
  const taskBaseHead = await head(canon)
  const base = await snapshotFullState(canon) // == HEAD tree (clean)
  // ours = canonical NOW: edit L2
  writeFileSync(join(canon, 'f.txt'), 'L1\nOURS\nL3\n')
  const ours = await snapshotFullState(canon)
  // theirs = the node's iso final tree: edit L2 differently
  writeFileSync(join(canon, 'f.txt'), 'L1\nTHEIRS\nL3\n')
  const theirs = await snapshotFullState(canon)
  // restore canon to the "ours" state (merge-back snapshots canon internally)
  writeFileSync(join(canon, 'f.txt'), 'L1\nOURS\nL3\n')

  const merge = await mergeTreeInMemory(canon, { base, ours, theirs })
  expect(merge.conflicts).toContain('f.txt')
  const conflict: MergeBackConflict = {
    worktreeDirName: '',
    paths: merge.conflicts,
    mergedTree: merge.mergedTree,
    rawConflictOutput: merge.rawConflictOutput,
    base,
    canonWorktreePath: canon,
    taskBaseHead,
  }
  return { canon, conflict, theirs }
}

describe('RFC-130 §6.2 — resolveConflictWithAgent (mock agent)', () => {
  test('agent removes markers → resolved, materialized into canon, resolve-iso discarded', async () => {
    const { canon, conflict } = await makeConflict()
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc130-ctr-'))
    let sawMarkers = false
    let sawPrompt = ''
    const out = await resolveConflictWithAgent(conflict, {
      containerPath: container,
      runAgent: async (prompt, cwd) => {
        sawPrompt = prompt
        // The resolve-iso must present the conflict markers for the agent to fix.
        sawMarkers = /^<{7}/m.test(readFileSync(join(cwd, 'f.txt'), 'utf8'))
        writeFileSync(join(cwd, 'f.txt'), 'L1\nMERGED\nL3\n') // clean resolution
      },
    })
    expect(sawMarkers).toBe(true)
    expect(sawPrompt).toContain('f.txt') // manifest injected into prompt
    expect(out.resolved).toBe(true)
    expect(out.unresolved).toEqual([])
    expect(out.resolveIsoPath).toBeNull()
    // Canonical worktree now carries the resolution (unstaged, HEAD unchanged).
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nMERGED\nL3\n')
    expect(await head(canon)).toBe(conflict.taskBaseHead)
    rimrafDir(canon)
    rimrafDir(container)
  })

  test('agent leaves markers → unresolved, canon UNTOUCHED, resolve-iso kept (D27/§6.3)', async () => {
    const { canon, conflict } = await makeConflict()
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc130-ctr-'))
    const out = await resolveConflictWithAgent(conflict, {
      containerPath: container,
      runAgent: async () => {
        /* agent does nothing — conflict markers remain */
      },
    })
    expect(out.resolved).toBe(false)
    expect(out.unresolved.map((e) => e.path)).toEqual(['f.txt'])
    expect(out.resolveIsoPath).not.toBeNull()
    // Resolve-iso preserved for the human.
    expect(existsSync(out.resolveIsoPath!)).toBe(true)
    // Canonical worktree is NOT polluted with markers — stays at "ours".
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nOURS\nL3\n')
    rimrafDir(canon)
    rimrafDir(container)
  })

  test('agent throws (opencode died) → unresolved, resolve-iso kept, canon untouched', async () => {
    const { canon, conflict } = await makeConflict()
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc130-ctr-'))
    const out = await resolveConflictWithAgent(conflict, {
      containerPath: container,
      runAgent: async () => {
        throw new Error('spawn opencode failed')
      },
    })
    expect(out.resolved).toBe(false)
    expect(out.resolveIsoPath).not.toBeNull()
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nOURS\nL3\n')
    rimrafDir(canon)
    rimrafDir(container)
  })

  // Codex P1 — fail closed: git reports a conflicted PATH whose CLASS the manifest
  // parser does not recognize (rename/rename, file/directory, …). Such a path is in
  // `conflict.paths` but absent from the manifest, so the agent is never told and
  // the per-path verdict can't judge it. Even a fully-resolving agent must NOT let
  // the resolution succeed (which would materialize the unhandled conflict).
  test('unrecognized conflict path (in conflict.paths, not in manifest) → fail closed, canon untouched', async () => {
    const { canon, conflict } = await makeConflict()
    // Inject a conflicted path the manifest classifier cannot see (no CONFLICT line
    // for it in rawConflictOutput) — simulates rename/rename / file-directory.
    conflict.paths = [...conflict.paths, 'ghost.txt']
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc130-ctr-'))
    const out = await resolveConflictWithAgent(conflict, {
      containerPath: container,
      // Agent "resolves" the marked file, but the ghost path is unhandled.
      runAgent: async (_prompt, cwd) => {
        writeFileSync(join(cwd, 'f.txt'), 'L1\nMERGED\nL3\n')
      },
    })
    expect(out.resolved).toBe(false)
    expect(out.unresolved.map((e) => e.path)).toContain('ghost.txt')
    expect(out.resolveIsoPath).not.toBeNull()
    // The unhandled conflict must NOT reach canonical.
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nOURS\nL3\n')
    rimrafDir(canon)
    rimrafDir(container)
  })

  // RFC-130 §6.3 resume — completeHumanResolvedConflict finishes a parked
  // conflict-human node from the human's edited resolve-iso. Mirrors §6.2① exactly:
  // the resolve-iso commit's PARENT is ours-at-conflict, which resume recovers via
  // `HEAD^` as the re-merge base (no DB column).
  async function makeConflictHumanState(humanContent: string): Promise<{
    canon: string
    handle: IsoHandle
    theirs: string
    container: string
  }> {
    const { canon, conflict, theirs } = await makeConflict() // canon left at "ours"
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc130-ctr-'))
    const oursAtConflict = await snapshotFullState(canon)
    const cmt = await commitTree(canon, conflict.mergedTree, oursAtConflict, 'aw-conflict')
    const resolveIso = join(container, 'resolve-repo')
    await runGit(canon, ['worktree', 'add', '--detach', resolveIso, cmt])
    writeFileSync(join(resolveIso, 'f.txt'), humanContent)
    const handle: IsoHandle = {
      taskId: 't',
      nodeRunId: 'n',
      containerPath: container,
      passthrough: false,
      repos: [
        {
          repoPath: canon,
          canonWorktreePath: canon,
          isoWorktreePath: join(container, 'node'),
          worktreeDirName: '',
          baseBranch: 'main',
          baseSnapshot: conflict.base,
          taskBaseHead: conflict.taskBaseHead,
        },
      ],
    }
    return { canon, handle, theirs, container }
  }

  test('resume: human resolved cleanly → materialized into canon, all resolved, iso discarded', async () => {
    const { canon, handle, theirs, container } = await makeConflictHumanState('L1\nHUMAN\nL3\n')
    const res = await completeHumanResolvedConflict(handle, { '': theirs })
    expect(res.allResolved).toBe(true)
    expect(res.unresolvedRepos).toEqual([])
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nHUMAN\nL3\n')
    expect(existsSync(join(container, 'resolve-repo'))).toBe(false) // discarded on success
    rimrafDir(canon)
    rimrafDir(container)
  })

  test('resume: human left conflict markers → NOT resolved, canon untouched, iso kept', async () => {
    const { canon, handle, theirs, container } = await makeConflictHumanState(
      'L1\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\nL3\n',
    )
    const res = await completeHumanResolvedConflict(handle, { '': theirs })
    expect(res.allResolved).toBe(false)
    expect(res.unresolvedRepos).toContain('')
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('L1\nOURS\nL3\n')
    expect(existsSync(join(container, 'resolve-repo'))).toBe(true) // kept for the human
    rimrafDir(canon)
    rimrafDir(container)
  })
})

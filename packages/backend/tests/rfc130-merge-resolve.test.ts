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
import { mergeTreeInMemory, runGit, snapshotFullState } from '../src/util/git'
import { type MergeBackConflict, resolveConflictWithAgent } from '../src/services/nodeIsolation'

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
async function makeConflict(): Promise<{ canon: string; conflict: MergeBackConflict }> {
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
  return { canon, conflict }
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
    rmSync(canon, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
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
    rmSync(canon, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
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
    rmSync(canon, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
  })
})

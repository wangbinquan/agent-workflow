import { rimrafDir } from './helpers/cleanup'
// RFC-130 T3 — per-node isolated worktree lifecycle (services/nodeIsolation.ts).
//
// Real git fixtures. Asserts the design-model end to end at the node-run level:
//   - createNodeIso → agent edits in iso → snapshotNodeIsoFinal → mergeBackNodeIso
//     lands the delta into the canonical worktree UNSTAGED, HEAD unchanged (§5)
//   - two concurrent nodes from the same base merge back to the UNION (AC-5)
//   - overlapping edits report a conflict, canonical for that repo left clean (D27)
//   - multi-repo isolates + merges per-repo (AC-13)
//   - failed node (no merge-back) leaves canonical untouched (AC-6/I-5)

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  discardNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '../src/services/nodeIsolation'
import { runGit } from '../src/util/git'

async function initCanon(seed: Record<string, string> = { 'base.txt': 'base\n' }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-iso-canon-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, c] of Object.entries(seed)) writeFileSync(join(dir, p), c)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}
async function head(dir: string): Promise<string> {
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}
const appHome = mkdtempSync(join(tmpdir(), 'aw-iso-home-'))

describe('RFC-130 node isolation lifecycle', () => {
  test('clean merge-back: agent edits in iso land in canonical UNSTAGED, HEAD unchanged', async () => {
    const canon = await initCanon()
    const baseHead = await head(canon)
    const handle = await createNodeIso({
      appHome,
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos: [canonRepo(canon)],
    })
    const iso = handle.repos[0]!.isoWorktreePath
    expect(existsSync(iso)).toBe(true)
    // agent works in the iso worktree
    writeFileSync(join(iso, 'base.txt'), 'edited-by-node\n')
    writeFileSync(join(iso, 'new.txt'), 'brand new\n')
    const nodeTrees = await snapshotNodeIsoFinal(handle)
    const res = await mergeBackNodeIso(handle, nodeTrees)
    expect(res.clean).toBe(true)
    // canonical got the changes, UNSTAGED, HEAD unchanged
    expect(readFileSync(join(canon, 'base.txt'), 'utf8')).toBe('edited-by-node\n')
    expect(readFileSync(join(canon, 'new.txt'), 'utf8')).toBe('brand new\n')
    expect(await head(canon)).toBe(baseHead)
    const diff = (await runGit(canon, ['diff', '--name-only'])).stdout
    expect(diff).toContain('base.txt')
    await discardNodeIso(handle)
    expect(existsSync(iso)).toBe(false)
    rimrafDir(canon)
  })

  test('two concurrent nodes from same base → canonical UNION of non-overlapping edits (AC-5)', async () => {
    const canon = await initCanon({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    const hA = await createNodeIso({
      appHome,
      taskId: 't2',
      nodeRunId: 'a',
      canonRepos: [canonRepo(canon)],
    })
    const hB = await createNodeIso({
      appHome,
      taskId: 't2',
      nodeRunId: 'b',
      canonRepos: [canonRepo(canon)],
    })
    // both branched from the same base; each edits a DIFFERENT file
    writeFileSync(join(hA.repos[0]!.isoWorktreePath, 'a.txt'), 'A-edited\n')
    writeFileSync(join(hB.repos[0]!.isoWorktreePath, 'b.txt'), 'B-edited\n')
    // A merges back first (canonical unchanged → clean), then B (canonical advanced → 3-way clean)
    expect((await mergeBackNodeIso(hA, await snapshotNodeIsoFinal(hA))).clean).toBe(true)
    expect((await mergeBackNodeIso(hB, await snapshotNodeIsoFinal(hB))).clean).toBe(true)
    expect(readFileSync(join(canon, 'a.txt'), 'utf8')).toBe('A-edited\n')
    expect(readFileSync(join(canon, 'b.txt'), 'utf8')).toBe('B-edited\n')
    await discardNodeIso(hA)
    await discardNodeIso(hB)
    rimrafDir(canon)
  })

  test('overlapping edits → conflict, canonical for that repo left clean (D27)', async () => {
    const canon = await initCanon({ 'c.txt': 'L1\nL2\nL3\n' })
    const hA = await createNodeIso({
      appHome,
      taskId: 't3',
      nodeRunId: 'a',
      canonRepos: [canonRepo(canon)],
    })
    const hB = await createNodeIso({
      appHome,
      taskId: 't3',
      nodeRunId: 'b',
      canonRepos: [canonRepo(canon)],
    })
    // both change L1 differently → true conflict
    writeFileSync(join(hA.repos[0]!.isoWorktreePath, 'c.txt'), 'A1\nL2\nL3\n')
    writeFileSync(join(hB.repos[0]!.isoWorktreePath, 'c.txt'), 'B1\nL2\nL3\n')
    expect((await mergeBackNodeIso(hA, await snapshotNodeIsoFinal(hA))).clean).toBe(true)
    const resB = await mergeBackNodeIso(hB, await snapshotNodeIsoFinal(hB))
    expect(resB.clean).toBe(false)
    expect(resB.conflicts[0]?.paths).toContain('c.txt')
    // canonical has A's clean result, NOT conflict markers (D27: main stays clean)
    const canonC = readFileSync(join(canon, 'c.txt'), 'utf8')
    expect(canonC).toBe('A1\nL2\nL3\n')
    expect(canonC).not.toContain('<<<<<<<')
    await discardNodeIso(hA)
    await discardNodeIso(hB)
    rimrafDir(canon)
  })

  test('multi-repo: isolate + merge-back per repo independently (AC-13)', async () => {
    const r1 = await initCanon({ 'x.txt': 'x\n' })
    const r2 = await initCanon({ 'y.txt': 'y\n' })
    const repos: CanonRepo[] = [
      { repoPath: r1, worktreePath: r1, worktreeDirName: 'r1', baseBranch: 'main' },
      { repoPath: r2, worktreePath: r2, worktreeDirName: 'r2', baseBranch: 'main' },
    ]
    const h = await createNodeIso({ appHome, taskId: 't4', nodeRunId: 'm', canonRepos: repos })
    writeFileSync(join(h.repos[0]!.isoWorktreePath, 'x.txt'), 'x-edited\n')
    writeFileSync(join(h.repos[1]!.isoWorktreePath, 'y.txt'), 'y-edited\n')
    const res = await mergeBackNodeIso(h, await snapshotNodeIsoFinal(h))
    expect(res.clean).toBe(true)
    expect(readFileSync(join(r1, 'x.txt'), 'utf8')).toBe('x-edited\n')
    expect(readFileSync(join(r2, 'y.txt'), 'utf8')).toBe('y-edited\n')
    await discardNodeIso(h)
    rimrafDir(r1)
    rimrafDir(r2)
  })

  test('failed node: no merge-back → canonical untouched (AC-6/I-5)', async () => {
    const canon = await initCanon({ 'f.txt': 'orig\n' })
    const h = await createNodeIso({
      appHome,
      taskId: 't5',
      nodeRunId: 'f',
      canonRepos: [canonRepo(canon)],
    })
    // agent wrote something in iso, then "failed" → we never merge back, just discard
    writeFileSync(join(h.repos[0]!.isoWorktreePath, 'f.txt'), 'partial garbage\n')
    await discardNodeIso(h)
    // canonical never saw the partial write
    expect(readFileSync(join(canon, 'f.txt'), 'utf8')).toBe('orig\n')
    expect((await runGit(canon, ['status', '--porcelain'])).stdout.trim()).toBe('')
    rimrafDir(canon)
  })
})

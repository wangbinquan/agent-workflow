import { rimrafDir } from './helpers/cleanup'
// RFC-130 T1 — per-node isolated worktree + serial merge-back git primitives.
//
// Locks the util/git.ts primitives that PR-A's scheduler wiring builds on, against
// real temp git repos. Each test asserts a design invariant (design.md refs inline):
//   - snapshotFullState captures untracked (D2) without touching the real index
//   - createIsolatedWorktree makes upstream changes UNSTAGED so plain `git diff`
//     still shows them (D23/D28, `reset --mixed` not `--soft`) + reflects deletions
//   - mergeTreeInMemory: non-overlapping = clean auto-merge, overlapping = conflict (D3)
//   - materializeTree applies add/mod/delete + file↔dir replacement, HEAD unchanged,
//     delta UNSTAGED (§5.3, Codex gate 五/六轮 deletion + blocking-dir handling)
//   - residualConflictMarkers pure oracle; isoRefName distinct base/node refs (D26)

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitTree,
  createIsolatedWorktree,
  hasDirtySubmoduleContent,
  isoRefName,
  materializeTree,
  mergeTreeInMemory,
  residualConflictMarkers,
  runGit,
  snapshotFullState,
} from '../src/util/git'
import { parseConflictManifest } from '../src/services/mergeAgent'

async function initRepo(seed: Record<string, string> = { 'base.txt': 'base\n' }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc130-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, content] of Object.entries(seed)) {
    const abs = join(dir, p)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
async function head(dir: string): Promise<string> {
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}
async function treeOf(dir: string, rev: string): Promise<string> {
  return (await runGit(dir, ['rev-parse', `${rev}^{tree}`])).stdout.trim()
}
async function show(dir: string, ref: string): Promise<string> {
  return (await runGit(dir, ['show', ref])).stdout
}
async function porcelain(dir: string): Promise<string> {
  return (await runGit(dir, ['status', '--porcelain'])).stdout
}
function freshIsoPath(): string {
  const p = mkdtempSync(join(tmpdir(), 'aw-rfc130-iso-'))
  rimrafDir(p) // worktree add requires the path to not exist
  return p
}

describe('RFC-130 T1 iso worktree primitives', () => {
  test('snapshotFullState captures tracked mods + untracked, leaves real index untouched (D2)', async () => {
    const repo = await initRepo()
    writeFileSync(join(repo, 'base.txt'), 'modified\n') // tracked mod
    writeFileSync(join(repo, 'new.txt'), 'untracked\n') // untracked add
    const snap = await snapshotFullState(repo)
    expect(await show(repo, `${snap}:base.txt`)).toBe('modified\n')
    expect(await show(repo, `${snap}:new.txt`)).toBe('untracked\n')
    // real worktree/index untouched: new.txt still untracked (temp index was used)
    expect(await porcelain(repo)).toContain('?? new.txt')
    rimrafDir(repo)
  })

  test('createIsolatedWorktree: upstream changes UNSTAGED via plain git diff, untracked stays untracked, deletion reflected (D23/D28)', async () => {
    const repo = await initRepo({ 'base.txt': 'base\n', 'del.txt': 'delete-me\n' })
    const taskBase = await head(repo)
    // simulate accumulated upstream changes in the canonical worktree:
    writeFileSync(join(repo, 'base.txt'), 'upstream-modified\n') // mod
    writeFileSync(join(repo, 'added.txt'), 'upstream-added\n') // untracked add
    rmSync(join(repo, 'del.txt')) // deletion
    const snap = await snapshotFullState(repo)

    const iso = freshIsoPath()
    await createIsolatedWorktree({
      repoPath: repo,
      isoPath: iso,
      baseSnapshotCommit: snap,
      taskBaseHead: taskBase,
    })
    // iso working tree == snapshot content
    expect(readFileSync(join(iso, 'base.txt'), 'utf8')).toBe('upstream-modified\n')
    expect(existsSync(join(iso, 'added.txt'))).toBe(true)
    expect(existsSync(join(iso, 'del.txt'))).toBe(false) // net checkout removed it
    // HEAD is the task base (not the snapshot)
    expect(await head(iso)).toBe(taskBase)
    // plain `git diff` (UNSTAGED) shows the mod + deletion — the D28 --mixed guarantee
    const diff = (await runGit(iso, ['diff', '--name-only'])).stdout
    expect(diff).toContain('base.txt')
    expect(diff).toContain('del.txt')
    // added.txt is UNTRACKED in the iso (matches today's shared-worktree model)
    expect(await porcelain(iso)).toContain('?? added.txt')

    await runGit(repo, ['worktree', 'remove', '--force', iso])
    rimrafDir(repo)
  })

  test('mergeTreeInMemory: non-overlapping edits auto-merge clean; overlapping edits conflict (D3)', async () => {
    const repo = await initRepo({ 'f.txt': 'L1\nL2\nL3\nL4\nL5\n' })
    const base = await head(repo)
    // ours: change L1
    writeFileSync(join(repo, 'f.txt'), 'OURS\nL2\nL3\nL4\nL5\n')
    const ours = await snapshotFullState(repo)
    await runGit(repo, ['checkout', '--', '.'])
    // theirs (non-overlap): change L5
    writeFileSync(join(repo, 'f.txt'), 'L1\nL2\nL3\nL4\nTHEIRS\n')
    const theirs = await snapshotFullState(repo)
    const clean = await mergeTreeInMemory(repo, { base, ours, theirs })
    expect(clean.conflicts).toEqual([])
    // merged tree has both edits
    expect(await show(repo, `${clean.mergedTree}:f.txt`)).toBe('OURS\nL2\nL3\nL4\nTHEIRS\n')

    // theirs (overlap): change L1 differently
    await runGit(repo, ['checkout', '--', '.'])
    writeFileSync(join(repo, 'f.txt'), 'CONFLICT\nL2\nL3\nL4\nL5\n')
    const theirsC = await snapshotFullState(repo)
    const conflicted = await mergeTreeInMemory(repo, { base, ours, theirs: theirsC })
    expect(conflicted.conflicts).toContain('f.txt')
    // The enriched result carries the raw CONFLICT messages (RFC-130 §6.2③).
    expect(conflicted.rawConflictOutput).toContain('CONFLICT (content): Merge conflict in f.txt')
    rimrafDir(repo)
  })

  // RFC-130 §6.2③ — the producer→classifier seam against REAL git: enriched
  // mergeTreeInMemory.rawConflictOutput → parseConflictManifest must recover the
  // conflict CLASS for content / modify-delete / binary in one three-way merge.
  // Binary + modify-delete are SILENT (no text markers) — the ONLY way to know
  // they conflicted is these messages, so a regression that drops --name-only's
  // replacement parsing would blind the merge agent to them.
  test('mergeTreeInMemory.rawConflictOutput classifies content + modify-delete + binary via parseConflictManifest', async () => {
    const bin0 = 'BIN\x00AAAA\n' // NUL byte ⟹ git treats it as binary
    const repo = await initRepo({ 'f.txt': 'L1\nL2\nL3\n', 'del.txt': 'keep\n', 'b.bin': bin0 })
    const base = await head(repo)
    // ours: edit f.txt L2, DELETE del.txt, change b.bin
    writeFileSync(join(repo, 'f.txt'), 'L1\nOURS\nL3\n')
    rmSync(join(repo, 'del.txt'))
    writeFileSync(join(repo, 'b.bin'), 'BIN\x00OURS\n')
    const ours = await snapshotFullState(repo)
    await runGit(repo, ['checkout', '--', '.'])
    await runGit(repo, ['clean', '-fdq'])
    // theirs: edit f.txt L2 differently, MODIFY del.txt, change b.bin differently
    writeFileSync(join(repo, 'f.txt'), 'L1\nTHEIRS\nL3\n')
    writeFileSync(join(repo, 'del.txt'), 'keep+theirs\n')
    writeFileSync(join(repo, 'b.bin'), 'BIN\x00THEIRS\n')
    const theirs = await snapshotFullState(repo)

    const res = await mergeTreeInMemory(repo, { base, ours, theirs })
    const manifest = parseConflictManifest(res.rawConflictOutput, 'repo')
    const byPath = Object.fromEntries(manifest.map((e) => [e.path, e.type]))
    expect(byPath['f.txt']).toBe('content')
    expect(byPath['del.txt']).toBe('modify-delete')
    expect(byPath['b.bin']).toBe('binary')
    // conflicts[] (paths) stays back-compat: all three present.
    expect(new Set(res.conflicts)).toEqual(new Set(['f.txt', 'del.txt', 'b.bin']))
    rimrafDir(repo)
  })

  test('commitTree wraps a tree OID into a worktree-add-able commit (P2-2)', async () => {
    const repo = await initRepo()
    const tree = await treeOf(repo, 'HEAD')
    const base = await head(repo)
    const cmt = await commitTree(repo, tree, base, 'aw-conflict')
    // the returned commit is checkoutable into a worktree
    const iso = freshIsoPath()
    const add = await runGit(repo, ['worktree', 'add', '--detach', iso, cmt])
    expect(add.exitCode).toBe(0)
    expect(existsSync(join(iso, 'base.txt'))).toBe(true)
    await runGit(repo, ['worktree', 'remove', '--force', iso])
    rimrafDir(repo)
  })

  test('materializeTree applies add/mod/delete, keeps HEAD, leaves delta UNSTAGED (§5.3)', async () => {
    const repo = await initRepo({ 'base.txt': 'base\n', 'del.txt': 'gone\n' })
    const taskBase = await head(repo)
    const canonTree = await treeOf(repo, 'HEAD')
    // build a merged tree = { base.txt: 'merged', new.txt added, del.txt removed }
    writeFileSync(join(repo, 'base.txt'), 'merged\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    rmSync(join(repo, 'del.txt'))
    const snap = await snapshotFullState(repo)
    const mergedTree = await treeOf(repo, snap)
    // reset worktree to base (materialize must produce the merged state from clean base)
    await runGit(repo, ['reset', '--hard', taskBase])
    expect(existsSync(join(repo, 'del.txt'))).toBe(true) // back

    await materializeTree(repo, { mergedTree, canonCurrentTree: canonTree, taskBaseHead: taskBase })
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('merged\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
    expect(existsSync(join(repo, 'del.txt'))).toBe(false) // deletion materialized
    expect(await head(repo)).toBe(taskBase) // HEAD unchanged
    // delta is UNSTAGED: base.txt modified + del.txt deleted show in plain diff
    const diff = (await runGit(repo, ['diff', '--name-only'])).stdout
    expect(diff).toContain('base.txt')
    expect(diff).toContain('del.txt')
    rimrafDir(repo)
  })

  test('materializeTree handles file→dir replacement (blocking path removed before checkout, Codex 五/六轮)', async () => {
    const repo = await initRepo({ foo: 'i am a file\n' })
    const taskBase = await head(repo)
    const canonTree = await treeOf(repo, 'HEAD')
    // merged tree replaces file `foo` with a directory `foo/` containing foo/bar
    rmSync(join(repo, 'foo'))
    mkdirSync(join(repo, 'foo'))
    writeFileSync(join(repo, 'foo', 'bar'), 'now a dir\n')
    const snap = await snapshotFullState(repo)
    const mergedTree = await treeOf(repo, snap)
    await runGit(repo, ['reset', '--hard', taskBase]) // worktree back: foo is a file again
    expect(existsSync(join(repo, 'foo'))).toBe(true)

    await materializeTree(repo, { mergedTree, canonCurrentTree: canonTree, taskBaseHead: taskBase })
    expect(readFileSync(join(repo, 'foo', 'bar'), 'utf8')).toBe('now a dir\n')
    rimrafDir(repo)
  })

  test('residualConflictMarkers pure oracle', () => {
    expect(residualConflictMarkers('clean text\n')).toBe(false)
    expect(residualConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> other\n')).toBe(true)
    expect(residualConflictMarkers('=======\n')).toBe(true)
    expect(residualConflictMarkers('a ======= b\n')).toBe(false) // markers must start the line
    expect(residualConflictMarkers('==== not seven ====\n')).toBe(false)
  })

  test('isoRefName gives distinct base/node refs under one nodeRun (D26)', () => {
    const b = isoRefName('task1', 'run1', 'base')
    const n = isoRefName('task1', 'run1', 'node')
    expect(b).toBe('refs/agent-workflow/iso/task1/run1/base')
    expect(n).toBe('refs/agent-workflow/iso/task1/run1/node')
    expect(b).not.toBe(n)
  })

  // RFC-130 D22 — snapshotFullState captures only a submodule's gitlink commit, not
  // uncommitted CONTENT inside it, so snapshotNodeIsoFinal must fail loud on such
  // edits. Locks the detector: fast-path false with no submodules; true once a file
  // inside a real submodule is edited.
  test('hasDirtySubmoduleContent: false with no submodules, true with dirty submodule content (D22)', async () => {
    const plain = await initRepo({ 'a.txt': 'x\n' })
    expect(await hasDirtySubmoduleContent(plain)).toBe(false)
    rimrafDir(plain)

    const sub = await initRepo({ 'lib.txt': 'v1\n' })
    const parent = await initRepo({ 'main.txt': 'top\n' })
    // A local-path submodule needs the file-protocol allowance (git ≥2.38 security).
    await runGit(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor'])
    await runGit(parent, ['commit', '-qm', 'add submodule'])
    expect(await hasDirtySubmoduleContent(parent)).toBe(false)
    writeFileSync(join(parent, 'vendor', 'lib.txt'), 'edited\n')
    expect(await hasDirtySubmoduleContent(parent)).toBe(true)
    rimrafDir(sub)
    rimrafDir(parent)
  })
})

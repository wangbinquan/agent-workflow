// RFC-239 T2/T3 — rename detection end-to-end. Locks:
//  - parseNameStatusZ: the NUL-separated `--name-status -z` token walk (R/C
//    two-path records, T/U/unknown handling, NO trimming of legal whitespace)
//  - gitChangedEntries(Between): staged/committed renames arrive as ONE R entry
//    with oldPath; an unstaged plain `mv` stays D + untracked A (git semantics,
//    documented limitation — untracked files cannot be rename-tracked)
//  - assemble: an R entry reads its old side from oldPath so symbol diffs are
//    modified/unchanged instead of a full delete+recreate, and the file carries
//    `renamedFrom` (pre-RFC-239 this misreported refactors as all-new code)
//  - gitDiffSnapshot: rename headers are explicit (`--find-renames`), not
//    dependent on the host's diff.renames default
//  - canonicalRepoKeys（RFC-248 取代 canonicalRepoLabels）：ONE key per repo
//    prefixes (sanitize-then-unique, design gate 3rd-round P1-N4)

import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gitChangedEntries,
  gitChangedEntriesBetween,
  gitDiffSnapshot,
  parseNameStatusZ,
  runGit,
} from '../src/util/git'
import { computeFromWorktree } from '../src/services/structuralDiff/gitBackend'
import { canonicalRepoKeys, canonicalRepoKeysWire } from '../src/services/repoLabels'

describe('parseNameStatusZ', () => {
  const z = (...tokens: string[]): string => tokens.join('\0') + '\0'

  test('single-path records: A/M/D/T', () => {
    const parsed = parseNameStatusZ(z('A', 'a.ts', 'M', 'b.ts', 'D', 'c.ts', 'T', 'd.ts'))
    expect(parsed.entries).toEqual([
      { path: 'a.ts', status: 'A' },
      { path: 'b.ts', status: 'M' },
      { path: 'c.ts', status: 'D' },
      { path: 'd.ts', status: 'T' },
    ])
    expect(parsed.skippedUnmerged).toEqual([])
    expect(parsed.unknownStatuses).toEqual([])
  })

  test('R and C consume two paths; C degrades to an add', () => {
    const parsed = parseNameStatusZ(z('R100', 'old.ts', 'new.ts', 'C75', 'src.ts', 'copy.ts'))
    expect(parsed.entries).toEqual([
      { path: 'new.ts', oldPath: 'old.ts', status: 'R' },
      { path: 'copy.ts', status: 'A' },
    ])
  })

  test('U is skipped (reported), unknown letters degrade to M (reported)', () => {
    const parsed = parseNameStatusZ(z('U', 'conflict.ts', 'Z', 'weird.ts', 'M', 'ok.ts'))
    expect(parsed.entries).toEqual([
      { path: 'weird.ts', status: 'M' },
      { path: 'ok.ts', status: 'M' },
    ])
    expect(parsed.skippedUnmerged).toEqual(['conflict.ts'])
    expect(parsed.unknownStatuses).toEqual(['Z'])
  })

  test('paths keep legal leading/trailing whitespace (NUL fields, no trim)', () => {
    const parsed = parseNameStatusZ(z('M', ' spaced file .ts'))
    expect(parsed.entries).toEqual([{ path: ' spaced file .ts', status: 'M' }])
  })

  test('truncated tail does not throw', () => {
    expect(parseNameStatusZ('R100\0old.ts').entries).toEqual([])
    expect(parseNameStatusZ('M').entries).toEqual([])
  })
})

describe('rename enumeration + assemble (real git)', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc239-'))
    dirs.push(dir)
    await runGit(dir, ['init', '-q', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    return dir
  }

  const PY = 'class Animal:\n    def speak(self):\n        return "woof"\n'

  test('staged pure rename → one R entry; assemble emits renamedFrom + no symbol changes', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'old_mod.py'), PY)
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    await runGit(dir, ['mv', 'old_mod.py', 'new_mod.py'])

    const entries = await gitChangedEntries(dir, 'HEAD')
    expect(entries).toEqual([{ path: 'new_mod.py', oldPath: 'old_mod.py', status: 'R' }])

    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    const f = diff.files.find((x) => x.filePath === 'new_mod.py')
    expect(f?.renamedFrom).toBe('old_mod.py')
    // real old content was read from oldPath → identical symbols → no changes,
    // NOT a wall of added + a wall of removed.
    expect(f?.changes).toEqual([])
    expect(diff.summary.methods.added).toBe(0)
    expect(diff.summary.methods.removed).toBe(0)
  })

  test('rename+edit → R entry whose symbol diff is modified (not delete+recreate)', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'a.py'), PY)
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    await runGit(dir, ['mv', 'a.py', 'b.py'])
    writeFileSync(join(dir, 'b.py'), 'class Animal:\n    def speak(self):\n        return "meow"\n')
    await runGit(dir, ['add', 'b.py'])

    const entries = await gitChangedEntries(dir, 'HEAD')
    expect(entries).toEqual([{ path: 'b.py', oldPath: 'a.py', status: 'R' }])

    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    const f = diff.files.find((x) => x.filePath === 'b.py')
    expect(f?.renamedFrom).toBe('a.py')
    const kinds = f?.changes.map((c) => c.changeType)
    expect(kinds).toContain('modified')
    expect(kinds).not.toContain('added')
    expect(kinds).not.toContain('removed')
  })

  test('unstaged plain mv keeps git semantics: D + untracked A (documented limit)', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'x.py'), PY)
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    renameSync(join(dir, 'x.py'), join(dir, 'y.py'))

    const entries = await gitChangedEntries(dir, 'HEAD')
    expect(entries).toEqual([
      { path: 'x.py', status: 'D' },
      { path: 'y.py', status: 'A' },
    ])
  })

  test('gitChangedEntriesBetween detects renames across two commits', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'a.py'), PY)
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'c1'])
    const c1 = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(dir, ['mv', 'a.py', 'src.py'])
    await runGit(dir, ['commit', '-q', '-m', 'c2'])
    const c2 = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()

    const entries = await gitChangedEntriesBetween(dir, c1, c2)
    expect(entries).toEqual([{ path: 'src.py', oldPath: 'a.py', status: 'R' }])
  })

  test('gitDiffSnapshot emits rename headers (explicit --find-renames)', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'a.py'), PY)
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    await runGit(dir, ['mv', 'a.py', 'renamed.py'])

    const diff = await gitDiffSnapshot(dir, 'HEAD')
    expect(diff).toContain('rename from a.py')
    expect(diff).toContain('rename to renamed.py')
  })
})

describe('canonicalRepoKeys（RFC-248 取代 RFC-239 的 canonicalRepoLabels）', () => {
  // RFC-239 那四条测试锁的是 basename fallback + CR/LF 消毒 + `-2` 去重 + 终极
  // 'repo' 兜底。RFC-248 把规范 key 换成**挂载路径**后，这四件事全部不再需要，
  // 也不再正确：
  //   - basename 在嵌套布局下丢方位（agent 拿到 `utils-2` 不知道该去哪个目录）；
  //   - 消毒会把 `apps/web` 毁成 `apps-web`，而挂载路径本来就带 `/`；
  //   - 唯一性由建组期的 `assertMountPathSet`（含大小写折叠）保证，不需后置去重；
  //   - 挂载路径经 `normalizeMountPath` 校验，不存在"消毒后啥也不剩"的输入。
  // 现在锁的是「原样返回挂载路径」这条更简单也更强的契约。
  test('原样返回挂载路径，不做任何消毒或去重', () => {
    expect(
      canonicalRepoKeys([
        { mountPath: '' },
        { mountPath: 'vendor/sdk' },
        { mountPath: 'apps/web' },
      ]),
    ).toEqual(['', 'vendor/sdk', 'apps/web'])
  })

  test('带 `/` 的挂载路径不得被压成 `-`（RFC-239 的老行为在这里是回归）', () => {
    expect(canonicalRepoKeys([{ mountPath: 'apps/web' }])).toEqual(['apps/web'])
  })

  test('线上形态：根仓写 `.`，其余原样', () => {
    expect(canonicalRepoKeysWire([{ mountPath: '' }, { mountPath: 'a/b' }])).toEqual(['.', 'a/b'])
  })
})

// RFC-060 PR-E E.T3 — wrapper-git output kind upgrade.
//
// `wrapper-git.git_diff` outlet was a full unified-diff string; now it is a
// newline-separated list of changed file paths (`list<path<*>>` per the kind
// grammar). Locks:
//
//   1. gitChangedFiles returns tracked + untracked paths, deduped, no
//      empty entries.
//   2. gitChangedFiles works against HEAD (no rev-parse).
//   3. Empty worktree (clean tree) → empty array.
//   4. scheduler.ts finalize block uses gitChangedFiles, not gitDiffSnapshot.
//   5. The git_diff port content is the newline join (downstream consumers
//      that split on '\n' get the right list).
//   6. Source-text lock: gitDiffSnapshot is no longer imported by scheduler.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitChangedFiles, runGit } from '../src/util/git'

async function makeRepo(): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc060-pre-'))
  mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# r\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('RFC-060 PR-E — gitChangedFiles helper', () => {
  test('clean worktree against HEAD → empty array', async () => {
    const { dir, cleanup } = await makeRepo()
    try {
      const files = await gitChangedFiles(dir, 'HEAD')
      expect(files).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('modified tracked file shows up', async () => {
    const { dir, cleanup } = await makeRepo()
    try {
      writeFileSync(join(dir, 'README.md'), '# r\nmore\n')
      const files = await gitChangedFiles(dir, 'HEAD')
      expect(files).toEqual(['README.md'])
    } finally {
      cleanup()
    }
  })

  test('untracked file is included', async () => {
    const { dir, cleanup } = await makeRepo()
    try {
      writeFileSync(join(dir, 'new.txt'), 'hello\n')
      const files = await gitChangedFiles(dir, 'HEAD')
      expect(files.sort()).toEqual(['new.txt'])
    } finally {
      cleanup()
    }
  })

  test('mixed: tracked modification + untracked → both, deduped', async () => {
    const { dir, cleanup } = await makeRepo()
    try {
      writeFileSync(join(dir, 'README.md'), '# r\nmore\n')
      writeFileSync(join(dir, 'new.txt'), 'hello\n')
      const files = await gitChangedFiles(dir, 'HEAD')
      expect(files.sort()).toEqual(['README.md', 'new.txt'])
    } finally {
      cleanup()
    }
  })

  test('non-ASCII paths survive without quoting (RFC-060 PR-E path stability)', async () => {
    const { dir, cleanup } = await makeRepo()
    try {
      writeFileSync(join(dir, '中文.md'), 'utf8\n')
      const files = await gitChangedFiles(dir, 'HEAD')
      expect(files).toContain('中文.md')
    } finally {
      cleanup()
    }
  })
})

describe('RFC-060 PR-E — scheduler finalize uses gitChangedFiles, not gitDiffSnapshot', () => {
  const SCHEDULER_PATH = resolve(import.meta.dirname, '..', 'src', 'services', 'scheduler.ts')
  const src = readFileSync(SCHEDULER_PATH, 'utf-8')

  test('finalize block calls gitChangedFiles（RFC-248：逐仓）', () => {
    // RFC-060 PR-E 锁的核心不变：finalize 用 `gitChangedFiles`（路径列表）而**不是**
    // `gitDiffSnapshot`（完整 patch）——`git_diff` 端口的类型是 `list<path<*>>`。
    //
    // RFC-248 D9 改的是**对谁**做：原来对单一 `wrapperCanonPath`（= repos[0] 的 iso
    // 根）做，这正是 RFC-066 当年必须禁掉多仓 wrapper-git 的根因（只看得见第一个
    // 仓）。现在遍历 `diffableRepos`（已滤掉只读成员）逐仓做，路径按挂载路径前缀化
    // 后合并。`wrapperCanonPath` 这个变量随之删除。
    expect(src).toContain('gitChangedFiles(r.path')
    expect(src).toContain('for (const r of diffableRepos)')
    // 反向锁：不得退回完整 patch。
    expect(src).not.toContain('gitDiffSnapshot(wrapperCanonPath')
    // 反向锁：不得退回只看第一个仓。
    expect(src).not.toContain('gitChangedFiles(wrapperCanonPath')
  })

  test('finalize block writes `paths.join("\\n")` as git_diff port content', () => {
    // RFC-144 D13: the write moved from a raw insert to upsertWrapperOutput —
    // wrapper rows are multi-generation (same-row revival), so the re-entry
    // generation REPLACES the prior generation's git_diff row instead of
    // violating the (node_run_id, port_name) PK. Same contract: the joined
    // changed-path list lands on the wrapper's git_diff port.
    expect(src).toMatch(/upsertWrapperOutput\(db, wrapperRunId, 'git_diff', paths\.join\('\\n'\)\)/)
  })

  test('scheduler no longer imports gitDiffSnapshot (gitChangedFiles replaces it)', () => {
    expect(src).not.toContain('import { gitDiffSnapshot')
    expect(src).not.toContain('gitDiffSnapshot,')
  })
})

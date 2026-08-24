// RFC-310 PR-7b T77/T79 —— conflict merge prepare/finish（真 git）。
//
// 锁：①方向固定 merge target into source，干净合并 = 'no-conflict'（不该走
// repair）；②冲突时 workspace 保留 conflict markers（MERGE_HEAD 在），
// conflictPaths 排序闭集；③finish 前残留 U → conflict-unresolved；④Agent 顺手
// 改冲突集外文件 → conflict-extra-changes（绝不顺手收编）；⑤merge commit 两
// parent 恰为 source/target、身份是平台内部 identity、不 push；⑥源码级禁
// conflict shortcut（-X ours/theirs、--strategy=、rebase）——冲突必须逐个人工
// 语义解决（T79 负锁；force push 面由 rfc310-pr7-no-merge-capability-scan 锁）。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  finishConflictMerge,
  prepareConflictMerge,
} from '../src/modules/source-control/application/conflictMerge'

setDefaultTimeout(120_000)

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't77',
      GIT_AUTHOR_EMAIL: 't77@test',
      GIT_COMMITTER_NAME: 't77',
      GIT_COMMITTER_EMAIL: 't77@test',
    },
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

/** base → source 分支改 X 行 1 → target 分支按 targetEdit 改。 */
function conflictRepo(
  targetEdit: { file: string; content: string },
  additionalTargetEdits: readonly { file: string; content: string }[] = [],
): {
  repo: string
  sourceSha: string
  targetSha: string
} {
  const repo = mkdtempSync(join(tmpdir(), 'rfc310-t77-repo-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'X.txt'), 'line1\nline2\n')
  writeFileSync(join(repo, 'other.txt'), 'other\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')

  git(repo, 'checkout', '-q', '-b', 'source')
  writeFileSync(join(repo, 'X.txt'), 'line1-from-source\nline2\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'source edit')
  const sourceSha = git(repo, 'rev-parse', 'HEAD').trim()

  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-q', '-b', 'target')
  for (const edit of [targetEdit, ...additionalTargetEdits]) {
    writeFileSync(join(repo, edit.file), edit.content)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'target edit')
  const targetSha = git(repo, 'rev-parse', 'HEAD').trim()

  git(repo, 'checkout', '-q', 'main')
  return { repo, sourceSha, targetSha }
}

describe('rfc310 pr7b T77 — conflict merge prepare/finish', () => {
  test('conflict path: markers preserved, only-conflict-set finish, platform merge commit; clean merge refuses repair', async () => {
    // ---- 冲突路：同文件同行两侧各改。
    const { repo, sourceSha, targetSha } = conflictRepo({
      file: 'X.txt',
      content: 'line1-from-target\nline2\n',
    })
    const prepared = await prepareConflictMerge({
      baselineRepoPath: repo,
      sourceSha,
      targetSha,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.conflictPaths).toEqual(['X.txt'])
    const conflicted = readFileSync(join(prepared.workspacePath, 'X.txt'), 'utf8')
    expect(conflicted).toContain('<<<<<<<')
    expect(conflicted).toContain('line1-from-source')
    expect(conflicted).toContain('line1-from-target')

    // 未解决就 finish → conflict-unresolved。
    const early = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      missionId: 'm-t77',
    })
    expect(early).toMatchObject({ ok: false, code: 'conflict-unresolved' })

    // 顺手改冲突集外文件 → conflict-extra-changes（解决冲突后仍拒）。
    writeFileSync(join(prepared.workspacePath, 'X.txt'), 'line1-merged\nline2\n')
    writeFileSync(join(prepared.workspacePath, 'other.txt'), 'sneaky edit\n')
    const sneaky = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      missionId: 'm-t77',
    })
    expect(sneaky).toMatchObject({ ok: false, code: 'conflict-extra-changes' })
    expect((sneaky as { detail: string }).detail).toContain('other.txt')

    // 撤掉顺手改动 → finish 成功：merge commit 两 parent = source/target。
    writeFileSync(join(prepared.workspacePath, 'other.txt'), 'other\n')
    const finished = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      missionId: 'm-t77',
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    const commitBody = git(prepared.workspacePath, 'cat-file', '-p', finished.mergeCommitSha)
    const parents = [...commitBody.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1])
    expect(parents).toEqual([sourceSha, targetSha])
    expect(commitBody).toContain('author agent-workflow <agent-workflow@localhost>')
    expect(commitBody).toContain('mission m-t77')
    expect(finished.treeOid).toMatch(/^[0-9a-f]{40}$/)
    const merged = git(prepared.workspacePath, 'show', 'HEAD:X.txt')
    expect(merged).toBe('line1-merged\nline2\n')
    prepared.cleanup()

    // ---- 干净合并路：target 改不同文件 → no-conflict（不该派 repair）。
    const clean = conflictRepo({ file: 'other.txt', content: 'target-side\n' })
    const cleanPrep = await prepareConflictMerge({
      baselineRepoPath: clean.repo,
      sourceSha: clean.sourceSha,
      targetSha: clean.targetSha,
    })
    expect(cleanPrep).toMatchObject({ ok: false, code: 'no-conflict' })
  })

  test('validated scene delta rebuilds a flattened index without dropping automatic target merges', async () => {
    const { repo, sourceSha, targetSha } = conflictRepo(
      { file: 'X.txt', content: 'line1-from-target\nline2\n' },
      [{ file: 'automatic.txt', content: 'target automatic merge result\n' }],
    )
    const prepared = await prepareConflictMerge({
      baselineRepoPath: repo,
      sourceSha,
      targetSha,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    // Agent scene materialization can preserve MERGE_HEAD and the business
    // tree while flattening the index back to source HEAD. The automatic target
    // result then looks like an ordinary out-of-conflict working-tree change.
    git(prepared.workspacePath, 'reset', '-q', 'HEAD', '--', '.')
    expect(git(prepared.workspacePath, 'diff', '--cached', '--name-only')).toBe('')
    expect(readFileSync(join(prepared.workspacePath, '.git', 'MERGE_HEAD'), 'utf8').trim()).toBe(
      targetSha,
    )
    expect(readFileSync(join(prepared.workspacePath, 'automatic.txt'), 'utf8')).toBe(
      'target automatic merge result\n',
    )

    writeFileSync(join(prepared.workspacePath, 'X.txt'), 'line1-merged\nline2\n')
    const finished = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      validatedChangedPaths: ['X.txt'],
      missionId: 'm-t77-flattened-index',
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    expect(git(prepared.workspacePath, 'show', 'HEAD:X.txt')).toBe('line1-merged\nline2\n')
    expect(git(prepared.workspacePath, 'show', 'HEAD:automatic.txt')).toBe(
      'target automatic merge result\n',
    )
    const parents = git(prepared.workspacePath, 'show', '-s', '--format=%P', 'HEAD')
      .trim()
      .split(' ')
    expect(parents).toEqual([sourceSha, targetSha])
    prepared.cleanup()
  })

  // T78：prepare 出来的现场要**直接交给 Agent 跑**，所以它必须与普通 action
  // workspace 同形。少了这两条中的任何一条都不会当场报错，而是在生产上以别的
  // 面目出现：留着 origin 等于给 Agent 留了一条自己发布的路；没有 RFC-308
  // exclude，平台自己写进 `.agent-workflow/` 的运行物会被 finish 的
  // 「冲突集之外不得有改动」判成 Agent 越界。
  test('T78: prepared workspace is Agent-ready — hosted under the given root, no remote, RFC-308 exclude', async () => {
    const { repo, sourceSha, targetSha } = conflictRepo({
      file: 'X.txt',
      content: 'line1-from-target\n',
    })
    const root = join(mkdtempSync(join(tmpdir(), 'rfc310-t78-home-')), 'workspaces', 'conflicts')
    const prepared = await prepareConflictMerge({
      baselineRepoPath: repo,
      sourceSha,
      targetSha,
      workspacesRoot: root,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.workspacePath.startsWith(root)).toBe(true)
    expect(git(prepared.workspacePath, 'remote').trim()).toBe('')
    expect(readFileSync(join(prepared.workspacePath, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.agent-workflow/',
    )
    // 平台运行物落进现场也不该成为「Agent 顺手改动」。
    mkdirSync(join(prepared.workspacePath, '.agent-workflow', 'inputs'), { recursive: true })
    writeFileSync(join(prepared.workspacePath, '.agent-workflow', 'inputs', 'x.md'), 'platform\n')
    writeFileSync(join(prepared.workspacePath, 'X.txt'), 'line1-merged\n')
    const finished = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      missionId: 'm-t78-shape',
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return

    // 幂等重入：收口与发布是两步，进程在两步之间挂掉后必须能原样回执，
    // 而不是撞 `nothing to commit` 把一次已经解好的冲突判成失败。
    const again = await finishConflictMerge({
      workspacePath: prepared.workspacePath,
      sourceSha,
      targetSha,
      conflictPaths: prepared.conflictPaths,
      missionId: 'm-t78-shape',
    })
    expect(again).toEqual(finished)
    prepared.cleanup()
  })

  test('T79 negative lock: no conflict shortcut anywhere in source-control', () => {
    const root = join(import.meta.dir, '../src/modules/source-control')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          walk(p)
          continue
        }
        if (!p.endsWith('.ts')) continue
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            const trimmed = line.trim()
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
              return
            if (/-X\s*(ours|theirs)|--strategy=|['"]rebase['"]|\brebase\s+--/.test(line)) {
              offenders.push(`${relative(root, p)}:${index + 1}: ${trimmed.slice(0, 90)}`)
            }
          })
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

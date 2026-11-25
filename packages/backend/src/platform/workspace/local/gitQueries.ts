// RFC-592 — two read-only git queries about a worktree, asked through the platform git runner (RFC-591): where its shared
// and admin git directories are (`gitMetaDirsFor`, for the runtime sandbox's write allowances) and whether an object
// is still in its object database (`gitCommitExists`, the fail-closed pre-check before a snapshot rollback). Moved
// verbatim from `util/git.ts`; like `gitVersion.ts` they know nothing of snapshots, worktree registration or branches,
// which stay with the repository semantics.

import { runGit } from '@/platform/execution/local/gitProcess'

/**
 * 一个 worktree 的共享 git 元数据目录（`--git-common-dir`）与它的 admin 目录
 * （linked worktree 的 `<common>/worktrees/<name>`）。
 *
 * RFC-281 用它填 `gitMetaDirs`：iso/linked worktree 的 `.git` 只是指针，`git add`
 * 要写 admin 目录的 `index.lock`、`git commit` 还要写共享 `objects/` —— 两者都在
 * 工作区之外。claude 的 sandbox 只对**会话 cwd** 自动解析共享 gitdir，对
 * `allowWrite`/`additionalDirectories` 里的其它 mount **不解析**（业务误伤检视
 * P2-1 实测），所以多仓任务的非主 mount 会出现「文件改得动、git 动不了」。
 *
 * 拿不到就返回空数组（§0：少一条放行也不阻断业务）。
 */
export async function gitMetaDirsFor(worktreePath: string): Promise<string[]> {
  try {
    const common = await runGit(worktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const commonDir = common.stdout.trim()
    if (commonDir.length === 0) return []
    const out = [commonDir]
    // linked worktree 的 admin 目录（`git rev-parse --git-dir` 指向它）。
    try {
      const own = await runGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'])
      const gitDir = own.stdout.trim()
      if (gitDir.length > 0 && gitDir !== commonDir) out.push(gitDir)
    } catch {
      /* admin dir 取不到不影响 common dir 的放行 */
    }
    return out
  } catch {
    return []
  }
}

/**
 * RFC-098 WP-9: `git cat-file -e <sha>^{commit}` — true iff the sha resolves
 * to a commit object still present in the odb. Used as the fail-closed
 * pre-check before any destructive rollback (a gc-pruned snapshot must be
 * detected BEFORE reset+clean destroy the worktree state).
 */
export async function gitCommitExists(repoPath: string, sha: string): Promise<boolean> {
  const r = await runGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
  return r.exitCode === 0
}

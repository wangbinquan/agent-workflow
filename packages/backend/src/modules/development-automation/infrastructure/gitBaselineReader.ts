// RFC-310 PR-3 T36a —— BaselineFileReader 的真实 Git 实现。
//
// `git ls-tree <head> -- <path>` 读 entry（mode 100644/100755=文件、040000=
// 目录、120000/160000=symlink/submodule ⇒ 'unsupported'）；内容 sha256 用
// `git cat-file blob <gitsha>` 的 stdout **流式落盘再 hash**——经 utf8 string
// 会损坏二进制字节，所以这里是 Bun.spawn 直连（rfc284 spawn allowlist 已
// 登记本文件），临时文件用后即删。

import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { runGit, nonInteractiveGitEnv } from '@/util/git'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import type { BaselineFileReader, BaselineStat } from '../application/uploadPlan'
import type { UploadBaselineContext } from '../application/commands/launchMission'

async function sha256OfFile(absPath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * 生产 resolveBaseline：repositoryId（cached_repos.id）→ 本地缓存 checkout 的
 * exact HEAD sha 冻结为 baseline。仓库未缓存/HEAD 不可解析 ⇒ null（launch 侧
 * 老实 blocked('baseline-reader-not-wired')，不猜默认分支）。
 */
export function createRepositoryBaselineResolver(
  db: DbClient,
): (repositoryId: string) => Promise<UploadBaselineContext | null> {
  return async (repositoryId) => {
    const row = db
      .select({ localPath: cachedRepos.localPath })
      .from(cachedRepos)
      .where(eq(cachedRepos.id, repositoryId))
      .get()
    if (row === undefined) return null
    const head = await runGit(row.localPath, ['rev-parse', 'HEAD'])
    if (head.exitCode !== 0) return null
    const sha = head.stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) return null
    return {
      repositoryRef: repositoryId,
      baselineSnapshotRef: `git:${sha}`,
      baselineSha: sha,
      reader: createGitBaselineReader(row.localPath, sha),
    }
  }
}

export function createGitBaselineReader(repoPath: string, headSha: string): BaselineFileReader {
  return {
    async stat(path: string): Promise<BaselineStat> {
      const lsTree = await runGit(repoPath, ['ls-tree', headSha, '--', path])
      if (lsTree.exitCode !== 0 || lsTree.stdout.trim().length === 0) return 'missing'
      const line = lsTree.stdout.split('\n')[0]!
      const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t/.exec(line)
      if (match === null) return 'missing'
      const [, mode, type, gitSha] = match
      if (type === 'tree' || mode === '040000') return 'directory'
      if (mode === '120000' || mode === '160000' || type !== 'blob') return 'unsupported'

      const staging = mkdtempSync(join(tmpdir(), 'aw-baseline-'))
      try {
        const outFile = join(staging, 'blob')
        const proc = Bun.spawn({
          ...platformSpawnOptionsForHost(),
          cmd: ['git', 'cat-file', 'blob', gitSha!],
          cwd: repoPath,
          env: { ...process.env, ...nonInteractiveGitEnv() } as Record<string, string>,
          stdout: Bun.file(outFile),
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) return 'missing'
        return {
          kind: 'file',
          sha256: await sha256OfFile(outFile),
          mode: mode === '100755' ? 'executable' : 'regular',
        }
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    },
  }
}

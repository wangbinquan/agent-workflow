import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, nonInteractiveGitEnv } from '@/util/git'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import type { BaselineFileReader, BaselineStat } from '../../application/uploadPlan'
import type {
  RepositoryBaselineEffects,
  RepositoryBaselineEffectsFactory,
} from '../../application/ports/repositoryBaselineEffects'

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

function createFileGitBaselineReader(repoPath: string, headSha: string): BaselineFileReader {
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

/** The original head and complete binary reader mechanisms, without admission policy. */
export function createFileRepositoryBaselineEffectsFactory(): RepositoryBaselineEffectsFactory {
  return {
    acquire(): RepositoryBaselineEffects {
      return {
        readHead(repositoryReference) {
          return runGit(repositoryReference, ['rev-parse', 'HEAD'])
        },
        bindFileReader(repositoryReference, baselineSha) {
          return createFileGitBaselineReader(repositoryReference, baselineSha)
        },
        close() {},
      }
    },
  }
}

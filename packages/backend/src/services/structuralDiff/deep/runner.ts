// RFC-083 PR-E — run a SCIP indexer with a timeout (I/O only). The spawn is
// injectable so tests drive the four outcomes (ok / non-zero / timeout / garbage
// output) with a stub binary — no real indexer in CI. The indexer runs with cwd
// = the worktree but writes SCIP to a scratch dir OUTSIDE it, so the agent's git
// diff is never dirtied.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree } from '@/util/process'
import type { IndexerSpec } from './indexers'

export type DeepDegradedReason = 'indexer-missing' | 'build-failed' | 'timeout' | 'scip-parse-error'

export interface IndexerRunResult {
  ok: boolean
  scipBytes?: Uint8Array
  reason?: DeepDegradedReason
}

/** A spawn shaped like the subset of Bun.spawn we use — so tests can inject. */
export type SpawnFn = (opts: {
  cmd: string[]
  cwd?: string
  stdout?: 'ignore' | 'pipe'
  stderr?: 'ignore' | 'pipe'
  stdin?: 'ignore'
  /**
   * RFC-317 T34（EK-01）—— 注入面也要能表达进程组，否则真实调用点想 detached 都写不出来。
   * 测试 stub 忽略它即可（stub 没有真 pid，杀链走的是另一支）。
   */
  detached?: boolean
}) => { exited: Promise<number>; kill: (signal?: number) => void; pid?: number }

export async function runIndexer(opts: {
  spec: IndexerSpec
  bin: string
  worktreePath: string
  timeoutMs: number
  spawn?: SpawnFn
}): Promise<IndexerRunResult> {
  const spawn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn)
  const scratch = await mkdtemp(join(tmpdir(), 'aw-scip-'))
  const outPath = join(scratch, 'index.scip')
  try {
    const proc = spawn({
      cmd: [opts.bin, ...opts.spec.buildArgs(outPath)],
      cwd: opts.worktreePath,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      // RFC-317 T34（EK-01）—— 自成进程组，否则下面那句 killProcessTree **静默降级**。
      //
      // POSIX 上 killProcessTree 先打 `process.kill(-pid)`；子进程若不是组长（没有
      // detached，它就待在 daemon 自己的组里），这一发抛 ESRCH，然后 catch 分支退回
      // `process.kill(pid)` —— 只杀直接子进程。调用点看起来在做树杀，实际没有，
      // 而且不报错。这里起的是 SCIP 索引器，它会 fork 整条编译工具链。
      detached: true,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // RFC-284 T17：单 pid kill 留活孙进程（stdout 虽 ignore 缓解管道悬挂，
      // 泄漏仍真实）——真进程换树杀；测试注入的 stub 无 pid，保持原 kill 缝。
      if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
      else
        try {
          proc.kill()
        } catch {
          /* already exited */
        }
    }, opts.timeoutMs)
    const code = await proc.exited
    clearTimeout(timer)

    if (timedOut) return { ok: false, reason: 'timeout' }
    if (code !== 0) return { ok: false, reason: 'build-failed' }

    let bytes: Uint8Array
    try {
      bytes = await readFile(outPath)
    } catch {
      return { ok: false, reason: 'build-failed' } // indexer produced no output
    }
    if (bytes.length === 0) return { ok: false, reason: 'build-failed' }
    return { ok: true, scipBytes: bytes }
  } catch {
    return { ok: false, reason: 'build-failed' }
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

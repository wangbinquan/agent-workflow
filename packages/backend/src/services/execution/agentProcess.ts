// RFC-280 T4 — B 层统一 agent 进程执行器：managedProcess 的 agent adapter
//（design §2.2 / 设计门 P1-2 + P2-1）。
//
// 职责边界：进程可靠性的唯一 authority 是 `managedProcess`（TERM→KILL 链、
// timeout/cancel 竞态语义、bounded pump/drain）——本模块**不复制任何计时器**，
// 只做 agent 语义的适配：
//   · 注入文件落盘（P1-7：attemptRoot containment + secret 0600/O_EXCL）
//   · beforeSpawn 准入 seam（经 managedProcess 透传）
//   · onSpawned PID 收据（抛错 = 收据 fence 失败 → abort 子进程 → 'aborted'，
//     P1-2 第 4 条：测试台在 spawn 后判定 turn 已不可投递时的既有语义）
//   · stdin 一次性投递（claude prompt 传输，经 managedProcess）
//   · typed outcome 映射与「reap 完成后才 cleanup」的强顺序
//
// 调用方分工（design §2.2）：行解析/落库经 capture 回调归调用方；结果域的再
// 分类（smoke 的 auth-missing / system agent 的 result-error 等）也归调用方——
// 本层只保证进程级 outcome 准确。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Logger } from '@/util/log'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import {
  runManagedProcess,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from './managedProcess'

export type AgentProcessOutcome =
  | 'ok'
  | 'nonzero-exit'
  | 'timeout'
  | 'aborted'
  | 'spawn-failed'
  | 'unreaped'

export interface AgentInjectionFile {
  /** attemptRoot 下的相对路径；绝对路径 / `..` 逃逸在落盘前拒绝（P1-7）。 */
  relativePath: string
  content: string
  /** true → 0600 + O_EXCL 原子独占创建（凭据文件，如 claude mcp-config）。 */
  secret: boolean
}

export interface AgentProcessRequest {
  cmd: readonly string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  termGraceMs?: number
  abortSignal?: AbortSignal
  stdin?: { mode: 'pipe'; data: string } | { mode: 'ignore' }
  /** spawn 前最后准入（抛错 = 不 spawn → 'spawn-failed'）。 */
  beforeSpawn?: () => void | Promise<void>
  /**
   * PID 收据 fence：子进程已存在、任何输出被读取之前 await。抛错 = 调用方
   * 判定 run 已不可继续（如测试台 turn 在 spawn 窗口内被取消）→ 本层立即
   * TERM→KILL 终止子进程，结果为 'aborted'。
   */
  onSpawned?: (receipt: {
    pid: number
    spawnedAt: number
    spawnBinaryPath: string
  }) => void | Promise<void>
  capture?: {
    onStdoutLine?: (line: string) => void | Promise<void>
    onStderrLine?: (line: string) => void | Promise<void>
    /** true → 结果含 byte-exact rolling-tail stdout（蒸馏器 envelope 解析）。 */
    rawStdout?: boolean
  }
  /** 注入文件的落盘根（files 非空时必填）。 */
  attemptRoot?: string
  files?: readonly AgentInjectionFile[]
  /**
   * reap 确认后才执行（P1-7 强顺序）；'unreaped' 时**跳过**（子进程可能仍
   * 持有目录）。失败不改写 outcome，仅 `cleanupFailed:true`。
   */
  cleanup?: () => void | Promise<void>
  log?: Logger
}

export interface AgentProcessResult {
  outcome: AgentProcessOutcome
  exitCode: number | null
  pid: number | null
  /** capture.rawStdout 时为 byte-exact rolling tail，否则 ''。 */
  rawStdout: string
  stderrTail: string
  durationMs: number
  spawnError?: string
  cleanupFailed?: boolean
}

export class AgentProcessFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentProcessFileError'
  }
}

/** P1-7 — 注入文件落盘：containment 检查 + secret 独占 0600。导出供单测直击。 */
export function materializeInjectionFiles(
  attemptRoot: string,
  files: readonly AgentInjectionFile[],
): void {
  for (const file of files) {
    const abs = resolve(attemptRoot, file.relativePath)
    if (!isLexicallyInsideForHost(attemptRoot, abs)) {
      throw new AgentProcessFileError(
        'agent-process-file-escape',
        `injection file '${file.relativePath}' resolves outside the attempt root`,
      )
    }
    mkdirSync(dirname(abs), { recursive: true })
    if (file.secret) {
      // O_EXCL：并发 attempt 复用同一路径时显式失败，绝不静默互相覆盖（P1-7）。
      writeFileSync(abs, file.content, { mode: 0o600, flag: 'wx' })
    } else {
      writeFileSync(abs, file.content)
    }
  }
}

function mapOutcome(mp: ManagedProcessResult, receiptFailed: boolean): AgentProcessOutcome {
  switch (mp.outcome) {
    case 'exited':
      // 收据 fence 失败后 escalate 的子进程通常仍以 exited 收场——fence 语义优先。
      if (receiptFailed) return 'aborted'
      return mp.exitCode === 0 ? 'ok' : 'nonzero-exit'
    case 'timeout':
      return receiptFailed ? 'aborted' : 'timeout'
    case 'aborted':
      return 'aborted'
    case 'spawn-failed':
      return 'spawn-failed'
    case 'child-unkillable':
      return 'unreaped'
  }
}

export async function runAgentProcess(req: AgentProcessRequest): Promise<AgentProcessResult> {
  const startedAt = Date.now()

  // 注入文件先于一切 spawn 动作落盘；违规 = spawn-failed，不产生子进程。
  if (req.files !== undefined && req.files.length > 0) {
    if (req.attemptRoot === undefined || req.attemptRoot === '') {
      return {
        outcome: 'spawn-failed',
        exitCode: null,
        pid: null,
        rawStdout: '',
        stderrTail: '',
        durationMs: Date.now() - startedAt,
        spawnError: 'agent-process-attempt-root-missing: files were given without an attemptRoot',
      }
    }
    try {
      materializeInjectionFiles(req.attemptRoot, req.files)
    } catch (err) {
      return {
        outcome: 'spawn-failed',
        exitCode: null,
        pid: null,
        rawStdout: '',
        stderrTail: '',
        durationMs: Date.now() - startedAt,
        spawnError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // 收据 fence：onSpawned 抛错 → 中止子进程（经与外部 signal 合并的 controller）。
  const controller = new AbortController()
  let receiptFailed = false
  const forwardAbort = (): void => controller.abort()
  if (req.abortSignal !== undefined) {
    if (req.abortSignal.aborted) controller.abort()
    else req.abortSignal.addEventListener('abort', forwardAbort, { once: true })
  }

  const mpRequest: ManagedProcessRequest = {
    argv: [...req.cmd],
    cwd: req.cwd,
    env: req.env,
    timeoutMs: req.timeoutMs,
    ...(req.termGraceMs !== undefined ? { killEscalationGraceMs: req.termGraceMs } : {}),
    signal: controller.signal,
    ...(req.beforeSpawn !== undefined ? { beforeSpawn: req.beforeSpawn } : {}),
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    ...(req.onSpawned !== undefined
      ? {
          onSpawned: async (info: { pid: number; spawnBinaryPath: string }) => {
            try {
              await req.onSpawned?.({
                pid: info.pid,
                spawnedAt: Date.now(),
                spawnBinaryPath: info.spawnBinaryPath,
              })
            } catch (err) {
              // P1-2：收据落库失败 = run 不可继续。managedProcess 对 onSpawned
              // 异常只 warn（收据是 best-effort of the RUN），所以 fence 语义在
              // 这里实现：标记 + abort，子进程走 TERM→KILL→reap。
              receiptFailed = true
              req.log?.warn('agent-process onSpawned receipt failed; aborting child', {
                pid: info.pid,
                error: err instanceof Error ? err.message : String(err),
              })
              controller.abort()
            }
          },
        }
      : {}),
    ...(req.capture?.onStdoutLine !== undefined ? { onStdoutLine: req.capture.onStdoutLine } : {}),
    ...(req.capture?.onStderrLine !== undefined ? { onStderrLine: req.capture.onStderrLine } : {}),
    ...(req.capture?.rawStdout === true ? { captureRawStdout: true } : {}),
    ...(req.log !== undefined ? { log: req.log } : {}),
  }

  let mp: ManagedProcessResult
  try {
    mp = await runManagedProcess(mpRequest)
  } finally {
    req.abortSignal?.removeEventListener('abort', forwardAbort)
  }

  const outcome = mapOutcome(mp, receiptFailed)

  // P1-7 强顺序：cleanup 只在 reap 确认后（managedProcess 返回即 reap 完成，
  // 唯 'unreaped'（child-unkillable）例外——子进程仍可能持有 attemptRoot。
  let cleanupFailed = false
  if (outcome !== 'unreaped' && req.cleanup !== undefined) {
    try {
      await req.cleanup()
    } catch (err) {
      cleanupFailed = true
      req.log?.warn('agent-process cleanup failed; artifacts retained', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    outcome,
    exitCode: mp.exitCode,
    pid: mp.pid,
    rawStdout: mp.rawStdout,
    stderrTail: mp.stderrTail,
    durationMs: Date.now() - startedAt,
    ...(mp.spawnError !== undefined ? { spawnError: mp.spawnError } : {}),
    ...(cleanupFailed ? { cleanupFailed: true } : {}),
  }
}

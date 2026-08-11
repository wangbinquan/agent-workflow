// RFC-280 T4 — B 层统一 agent 进程执行器：managedProcess 的 agent adapter
//（design §2.2 / 设计门 P1-2 + P2-1）。
//
// 职责边界：进程可靠性的唯一 authority 是 `managedProcess`（TERM→KILL 链、
// timeout/cancel 竞态语义、bounded pump/drain）——本模块**不复制任何计时器**，
// 只做 agent 语义的适配：
//   · beforeSpawn 准入 seam（经 managedProcess 透传）
//   · onSpawned PID 收据（抛错 = 收据 fence 失败 → abort 子进程 → 'aborted'，
//     P1-2 第 4 条：测试台在 spawn 后判定 turn 已不可投递时的既有语义）
//   · stdin 一次性投递（claude prompt 传输，经 managedProcess）
//   · typed outcome 映射与「reap 完成后才 cleanup」的强顺序
//
// 调用方分工（design §2.2）：行解析/落库经 capture 回调归调用方；结果域的再
// 分类（smoke 的 auth-missing / system agent 的 result-error 等）也归调用方——
// 本层只保证进程级 outcome 准确。

import type { Logger } from '@/util/log'
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

export interface AgentProcessRequest {
  cmd: readonly string[]
  cwd: string
  env: Record<string, string>
  /** Omit for no wall-clock timeout (managedProcess treats undefined as none). */
  timeoutMs?: number
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
    /** 行被截断投递时通知（capture-faithful 调用方标记取证不完整）。 */
    onLineTruncated?: () => void | Promise<void>
    /** true → 结果含 byte-exact rolling-tail stdout（蒸馏器 envelope 解析）。 */
    rawStdout?: boolean
  }
  /**
   * reap 确认后才执行（管道 reap 之后的强顺序）；'unreaped' 时**跳过**（子进程
   * 可能仍持有目录）。失败不改写 outcome，仅 `cleanupFailed:true`。
   *
   * NB（impl-gate P2-D）：注入的凭据文件（claude mcp-config.json 等）由各
   * driver 的 buildSpawn/buildBusinessSpawn 直接写在 per-run/per-turn 目录下
   * （`0600`、driver 控制的路径），其清理走这里的 cleanup / plan.cleanup /
   * finalizePlan。执行器不再代管文件落盘——路径由 driver 控制、目录 per-run
   * 隔离，天然无越界面。
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
  /** exited 后管道未在期限内 EOF（孙进程持有）——exitCode 可信，尾流丢失。 */
  drainTimedOut?: boolean
  /** 行回调抛错（如落库失败）：子进程已被 escalate，此处携带首个原因。 */
  pumpError?: string
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
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
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
    ...(req.capture?.onLineTruncated !== undefined
      ? { onLineTruncated: req.capture.onLineTruncated }
      : {}),
    // agent 域：exited 后 drain 超时 = 取证降级而非 unsafe child（smoke 的
    // bounded flush / 蒸馏器 drain-grace / systemAgentRun 的 post-exit-flush
    // 三处历史语义一致——exitCode 可信，尾流丢失单独上报）。
    keepExitedOnDrainTimeout: true,
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
  // 唯 'unreaped'（child-unkillable）例外——子进程仍可能持有该目录。
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
    ...(mp.drainTimedOut === true ? { drainTimedOut: true } : {}),
    ...(mp.pumpError !== undefined ? { pumpError: mp.pumpError } : {}),
  }
}

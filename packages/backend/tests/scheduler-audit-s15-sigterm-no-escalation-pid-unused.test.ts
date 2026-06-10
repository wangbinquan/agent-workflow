// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-15 (WP-8)
//
// 指控已逐条对源码核实（基线 HEAD f9db99f 附近），全部属实，本文件以源码文本
// 守卫锁定现状（目标函数 safeKill 未导出，无法纯函数直测；不合作子进程的真实
// 进程级测试留给 WP-8 的 oracle——报告明言"现有 mock 是配合型，从未测过此形态"）：
//
//   1. 取消/超时只发一次 SIGTERM，无 SIGKILL 升级链——safeKill 的签名
//      （runner.ts:1506）支持 'SIGTERM' | 'SIGKILL'，但全部调用点
//      （runner.ts:766 abort 路径、:777 timeout 路径）只传过 'SIGTERM'；
//      'SIGKILL' 字面量在 runner.ts 非注释行恰好出现 1 次（即签名类型本身）。
//      对照：pluginInstaller.ts:385 有现成的 kill('SIGKILL') 超时模式，runner 未用。
//   2. `await child.exited`（runner.ts:933）是无界等待：无 Promise.race、无
//      最终超时——无视 SIGTERM 的 opencode 子进程（docker MCP 等）可让节点
//      永久挂起，且该形态落在 stuckTaskDetector S1-S4 的盲区。
//   3. nodeRuns.pid 落库后从未被任何进程治理逻辑消费：唯一写点
//      runner.ts:757 `set({ pid: child.pid })`；唯一读点 task.ts:1441 把它映射
//      进 API DTO（纯展示）。orphans.ts / stuckTaskDetector.ts 零 pid 引用，
//      services 下 isProcessAlive 零命中（活性探测只存在于 util/lock.ts 的
//      daemon 单实例锁，从未用于 node_run 孤儿收割 / resume 前置检查）。
//
// 正确语义：SIGTERM 后固定宽限升级 SIGKILL；child.exited 加最终超时；spawn 自成
// 进程组按组杀覆盖孙进程；reapOrphanRuns/resumeTask 前用 pid 做存活检查
// （结合 startedAt 时间窗降噪 pid 复用）；stuckTaskDetector 增 S5 规则。
//
// 修复落点：WP-8。修复时本文件应翻红，按断言旁 FLIP 注释翻转：
// 届时改为"必须存在 SIGKILL 升级路径 / 必须存在 exited 超时 / pid 必须有
// 治理消费点"的正向守卫。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const RUNNER = resolve(BACKEND_SRC, 'services', 'runner.ts')
const ORPHANS = resolve(BACKEND_SRC, 'services', 'orphans.ts')
const STUCK = resolve(BACKEND_SRC, 'services', 'stuckTaskDetector.ts')
const TASK = resolve(BACKEND_SRC, 'services', 'task.ts')
const SERVICES_DIR = resolve(BACKEND_SRC, 'services')

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function nonCommentLines(content: string): string[] {
  return content.split('\n').filter((l) => !isCommentLine(l))
}

function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of nonCommentLines(content)) {
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

describe('S-15 lock: single SIGTERM, no SIGKILL escalation (runner.ts)', () => {
  const runnerSrc = readFileSync(RUNNER, 'utf8')

  test('all kill paths route through safeKill, and every call site passes SIGTERM only', () => {
    // child.kill(...) 只出现在 safeKill 体内一次——升级链若要落地必须经过这里。
    expect(countNonCommentMatches(runnerSrc, /child\.kill\(/g)).toBe(1)

    // abort 路径 + timeout 路径 = 恰好 2 个调用点，都是 SIGTERM。
    expect(countNonCommentMatches(runnerSrc, /safeKill\(child, 'SIGTERM'\)/g)).toBe(2)

    // FLIP (WP-8): 升级链落地后这里应 ≥1（SIGTERM 宽限期后补 SIGKILL）。
    expect(countNonCommentMatches(runnerSrc, /safeKill\(child, 'SIGKILL'\)/g)).toBe(0)

    // 'SIGKILL' 字面量唯一的非注释出现就是 safeKill 的签名类型——能力存在、
    // 从未被使用（签名变了说明有人动了 kill 协议，须重审本守卫）。
    expect(countNonCommentMatches(runnerSrc, /'SIGKILL'/g)).toBe(1)
    expect(runnerSrc).toContain(
      "function safeKill(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void",
    )
  })

  test('`await child.exited` is a single unbounded wait — no race, no final timeout', () => {
    expect(countNonCommentMatches(runnerSrc, /await child\.exited/g)).toBe(1)
    // FLIP (WP-8): exited 加最终超时（Promise.race 或等价机制）后翻转为 ≥1。
    expect(countNonCommentMatches(runnerSrc, /Promise\.race/g)).toBe(0)
  })
})

describe('S-15 lock: nodeRuns.pid is write-only for process governance', () => {
  test('single write point in runner.ts; the only read maps it into the API DTO (display-only)', () => {
    const runnerSrc = readFileSync(RUNNER, 'utf8')
    expect(countNonCommentMatches(runnerSrc, /\.set\(\{ pid: child\.pid \}\)/g)).toBe(1)

    // task.ts 全文件仅 1 个非注释 pid 引用，且是 DTO 映射行（纯展示读）。
    const taskPidLines = nonCommentLines(readFileSync(TASK, 'utf8')).filter((l) =>
      /\bpid\b/.test(l),
    )
    expect(taskPidLines.length).toBe(1)
    expect(taskPidLines[0]).toMatch(/pid: r\.pid/)
  })

  test('orphan reaper and stuck detector are pid-blind; no liveness probe anywhere in services', () => {
    // FLIP (WP-8): reapOrphanRuns/resumeTask 接入 pid 存活检查、stuck S5 规则
    // 带 pid 告警后，下面三个 0 断言应翻转（并把本用例改为正向守卫）。
    expect(countNonCommentMatches(readFileSync(ORPHANS, 'utf8'), /\bpid\b/gi)).toBe(0)
    expect(countNonCommentMatches(readFileSync(STUCK, 'utf8'), /\bpid\b/gi)).toBe(0)

    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(p))
        else if (entry.name.endsWith('.ts')) out.push(p)
      }
      return out
    }
    let liveness = 0
    for (const f of walk(SERVICES_DIR)) {
      liveness += countNonCommentMatches(readFileSync(f, 'utf8'), /isProcessAlive/g)
    }
    expect(liveness).toBe(0)
  })
})

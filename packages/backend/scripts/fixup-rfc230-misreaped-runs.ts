// RFC-230 — one-off fixup for node_runs that the periodic orphan reconciler
// mis-reaped before the liveness-evidence fix landed.
//
// 症状（改动前的确切形状）：周期回收器把「没有 pid」当成「进程已消失」，于是
// 每一行**从不 spawn 子进程**的 run —— 典型是 wrapper（git / loop / fanout）的
// 记账行 —— 只要 running 超过 60s 宽限期，就被翻成 interrupted：
//
//   - node_runs.status        = 'interrupted'
//   - node_runs.error_message = 'orphan-reconcile'
//   - node_runs.pid           IS NULL
//   - node_runs.spawn_binary_path IS NULL      ← 从未 spawn 过的铁证
//
// 有 pid 的行不在此列：那些是真的做过进程判活，判死可能是对的，脚本一律不碰。
//
// 脚本只做一件事：把上述精确形状的行退回 'failed'，让既有的 resume / 诊断修复
// 入口能正常接手（interrupted 与 failed 都可 resume，但 failed 会带上原因，
// 用户在任务详情里看得到发生过什么）。**不改任务行状态** —— 任务级恢复交给
// resume，脚本不越权。
//
// 形状不符即拒绝触碰 DB（与 fixup-rfc052 同范式）。
//
// IMPORTANT: 跑之前停 daemon。
//
// Run:
//   bun run --filter @agent-workflow/backend scripts/fixup-rfc230-misreaped-runs.ts --dry-run
//   bun run --filter @agent-workflow/backend scripts/fixup-rfc230-misreaped-runs.ts
//
// Optional flags:
//   --db <path>       override the sqlite path (default ~/.agent-workflow/db.sqlite)
//   --task-id <id>    只处理某一个任务
//   --dry-run         只打印将要改动的行，不写库

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { and, eq, isNull } from 'drizzle-orm'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import * as schema from '@/db/schema'
import { nodeRuns } from '@/db/schema'

const FIXUP_MESSAGE = 'orphan-reconcile (RFC-230 mis-reap; rolled back for resume)'

interface CliArgs {
  dbPath: string
  taskId: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    dbPath: resolve(homedir(), '.agent-workflow', 'db.sqlite'),
    taskId: null,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--db') out.dbPath = resolve(argv[++i] ?? '')
    else if (a === '--task-id') out.taskId = argv[++i] ?? null
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = drizzle(new Database(args.dbPath), { schema })

  // 精确形状：interrupted + 回收器留下的 error_message + 从未 spawn 过。
  const where = and(
    eq(nodeRuns.status, 'interrupted'),
    eq(nodeRuns.errorMessage, 'orphan-reconcile'),
    isNull(nodeRuns.pid),
    isNull(nodeRuns.spawnBinaryPath),
    ...(args.taskId !== null ? [eq(nodeRuns.taskId, args.taskId)] : []),
  )
  const victims = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      finishedAt: nodeRuns.finishedAt,
    })
    .from(nodeRuns)
    .where(where)

  if (victims.length === 0) {
    console.log('[rfc-230] 没有符合误收形状的行 —— 未触碰 DB')
    return
  }
  console.log(`[rfc-230] 命中 ${victims.length} 行：`)
  for (const v of victims) {
    console.log(`  task=${v.taskId} node=${v.nodeId} run=${v.id}`)
  }
  if (args.dryRun) {
    console.log('[rfc-230] --dry-run：未写库')
    return
  }
  for (const v of victims) {
    // CAS 到观察时的状态：跑脚本期间有别的写者动过就跳过，不覆盖。
    await db
      .update(nodeRuns)
      .set({ status: 'failed', errorMessage: FIXUP_MESSAGE })
      .where(and(eq(nodeRuns.id, v.id), eq(nodeRuns.status, 'interrupted')))
  }
  console.log(`[rfc-230] 已退回 ${victims.length} 行为 failed；用 resume 继续这些任务。`)
}

await main()

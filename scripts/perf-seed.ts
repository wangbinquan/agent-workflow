// RFC-311 T30 — 基准库生成器(proposal §6:10 万任务 / 300 万 node_runs /
// 千万级事件行 / 10 万 webhook 投递 / 500 仓)。
//
// 不进 CI 门禁;开发机手动跑:
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db --small   # 1% 快速档
//
// 写入姿势:openDb 先把迁移与 PRAGMA 铺好,随后用第二条 bun:sqlite 原生连接
// (WAL 允许并存)以 prepared statement + 大事务批量写——比走 ORM 快一个量级。
// 生成的数据满足 RFC-311 PR-4 的物化列不变量(branch_started_at = 子树
// max(started_at)),否则 /api/tasks/page 快路径的基准数字不可信。

/* eslint-disable no-console */

import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDb } from '../packages/backend/src/db/client'

interface Args {
  db: string
  tasks: number
  runsPerTask: number
  events: number
  deliveries: number
  repos: number
  reset: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const small = argv.includes('--small')
  const scale = small ? 0.01 : 1
  const num = (name: string, dflt: number): number => {
    const raw = flag(name)
    return raw === undefined ? Math.max(1, Math.round(dflt * scale)) : Number(raw)
  }
  return {
    db: resolve(flag('db') ?? '/tmp/aw-perf/agent-workflow.db'),
    tasks: num('tasks', 100_000),
    runsPerTask: Number(flag('runs-per-task') ?? 30),
    events: num('events', 10_000_000),
    deliveries: num('deliveries', 100_000),
    repos: num('repos', 500),
    reset: argv.includes('--reset'),
  }
}

const args = parseArgs()
const MIGRATIONS = resolve(import.meta.dir, '..', 'packages', 'backend', 'db', 'migrations')
const T0 = Date.parse('2026-01-01T00:00:00Z')
const SPAN = Date.parse('2026-08-01T00:00:00Z') - T0

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

if (args.reset && existsSync(args.db)) {
  rmSync(args.db)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(args.db + suffix)) rmSync(args.db + suffix)
  }
}
mkdirSync(dirname(args.db), { recursive: true })

console.log(`[perf-seed] migrating ${args.db}`)
openDb({ path: args.db, migrationsFolder: MIGRATIONS })

const raw = new Database(args.db)
raw.exec('PRAGMA journal_mode = WAL;')
raw.exec('PRAGMA synchronous = OFF;') // 基准库可重建,写入期换速度
raw.exec('PRAGMA busy_timeout = 10000;')

function tx(fn: () => void): void {
  raw.exec('BEGIN')
  try {
    fn()
    raw.exec('COMMIT')
  } catch (e) {
    raw.exec('ROLLBACK')
    throw e
  }
}

const started = Date.now()
const STATUSES = ['done', 'done', 'done', 'failed', 'canceled', 'running', 'pending'] as const

// --- users / workflow --------------------------------------------------------
tx(() => {
  raw
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    )
    .run('perf-admin', 'perf-admin', 'perf-admin', T0, T0)
  raw
    .prepare(`INSERT OR IGNORE INTO workflows (id, name, definition) VALUES (?, ?, ?)`)
    .run('perf-wf', 'perf-wf', JSON.stringify({ nodes: [], edges: [], inputs: [] }))
})

// --- repos -------------------------------------------------------------------
console.log(`[perf-seed] repos: ${args.repos}`)
tx(() => {
  const ins = raw.prepare(
    `INSERT OR IGNORE INTO cached_repos
       (id, url_hash, url_redacted, local_path, default_branch, last_fetched_at, created_at,
        last_auto_refresh_at, has_submodules, last_submodule_sync_ok)
     VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?)`,
  )
  for (let i = 0; i < args.repos; i += 1) {
    const id = `perfrepo${pad(i, 6)}`
    ins.run(
      id,
      id.slice(0, 8),
      `git@example.com:perf/repo-${i}.git`,
      `/cache/perf/repo-${i}`,
      T0 + ((i * 7919) % SPAN),
      T0,
      i % 3 === 0 ? T0 + i : null,
      i % 4 === 0 ? 1 : i % 4 === 1 ? 0 : null,
      i % 8 === 0 ? 0 : 1,
    )
  }
})

// --- tasks -------------------------------------------------------------------
// 90% 根任务,10% 挂一个子任务(锁 branch_started_at = 子树 max 的不变量:
// 子任务 startedAt 晚于父,父行的 branch_started_at 取子值)。
console.log(`[perf-seed] tasks: ${args.tasks}`)
const CHUNK = 20_000
for (let base = 0; base < args.tasks; base += CHUNK) {
  const hi = Math.min(base + CHUNK, args.tasks)
  tx(() => {
    const ins = raw.prepare(
      `INSERT OR IGNORE INTO tasks
         (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch,
          status, inputs, started_at, finished_at, running_ms, owner_user_id, launch_origin,
          parent_task_id, invocation_depth, cached_repo_id, branch_started_at)
       VALUES (?, ?, 'perf-wf', '{}', ?, ?, 'main', ?, ?, '{}', ?, ?, 0, 'perf-admin', 'manual', ?, ?, ?, ?)`,
    )
    for (let i = base; i < hi; i += 1) {
      const id = `perftask${pad(i, 7)}`
      const startedAt = T0 + ((i * 104_729) % SPAN)
      const isChild = i % 10 === 9
      const parentId = isChild ? `perftask${pad(i - 1, 7)}` : null
      const childStartedAt = startedAt + 60_000
      const status = STATUSES[i % STATUSES.length]!
      const finished = status === 'done' || status === 'failed' || status === 'canceled'
      ins.run(
        id,
        `perf task ${i}`,
        `/repo/perf-${i % 97}`,
        `/wt/perf-${i}`,
        `agent-workflow/${id}`,
        status,
        isChild ? childStartedAt : startedAt,
        finished ? startedAt + 120_000 : null,
        parentId,
        isChild ? 1 : 0,
        `perfrepo${pad(i % args.repos, 6)}`,
        // 根行:若下一行(i+1)会成为自己的孩子,branch_started_at 取孩子的
        // startedAt(更晚);否则取自身。子行取自身。
        isChild
          ? childStartedAt
          : (i + 1) % 10 === 9 && i + 1 < args.tasks
            ? T0 + (((i + 1) * 104_729) % SPAN) + 60_000
            : startedAt,
      )
    }
  })
  console.log(`[perf-seed]   tasks ${hi}/${args.tasks}`)
}

// --- node_runs ---------------------------------------------------------------
const totalRuns = args.tasks * args.runsPerTask
console.log(`[perf-seed] node_runs: ${totalRuns}`)
const RUN_STATUSES = ['done', 'done', 'done', 'failed', 'running'] as const
const RUN_CHUNK = 50_000
let runRow = 0
for (let base = 0; base < totalRuns; base += RUN_CHUNK) {
  const hi = Math.min(base + RUN_CHUNK, totalRuns)
  tx(() => {
    const ins = raw.prepare(
      `INSERT OR IGNORE INTO node_runs
         (id, task_id, node_id, status, iteration, retry_index, started_at, finished_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    for (let i = base; i < hi; i += 1) {
      const taskIdx = i % args.tasks
      const seq = Math.floor(i / args.tasks)
      const startedAt = T0 + ((taskIdx * 104_729) % SPAN) + seq * 1000
      const status = RUN_STATUSES[i % RUN_STATUSES.length]!
      ins.run(
        `perfrun${pad(i, 8)}`,
        `perftask${pad(taskIdx, 7)}`,
        `node-${seq}`,
        status,
        startedAt,
        status === 'running' ? null : startedAt + 900,
      )
      runRow += 1
    }
  })
  console.log(`[perf-seed]   node_runs ${hi}/${totalRuns}`)
}

// --- node_run_events ---------------------------------------------------------
console.log(`[perf-seed] events: ${args.events}`)
const PAYLOAD = JSON.stringify({
  type: 'text',
  part: { text: 'perf event payload '.repeat(8) },
})
const EV_CHUNK = 100_000
for (let base = 0; base < args.events; base += EV_CHUNK) {
  const hi = Math.min(base + EV_CHUNK, args.events)
  tx(() => {
    const ins = raw.prepare(
      `INSERT INTO node_run_events (node_run_id, ts, kind, payload) VALUES (?, ?, 'text', ?)`,
    )
    for (let i = base; i < hi; i += 1) {
      // 事件集中在前 2% 的 run(热点 run 很大、其余稀疏——贴近生产分布)。
      const hotRuns = Math.max(1, Math.floor(totalRuns * 0.02))
      const runIdx = i % 3 === 0 ? i % hotRuns : i % totalRuns
      ins.run(`perfrun${pad(runIdx, 8)}`, T0 + i, PAYLOAD)
    }
  })
  console.log(`[perf-seed]   events ${hi}/${args.events}`)
}

// --- webhook deliveries ------------------------------------------------------
console.log(`[perf-seed] webhook deliveries: ${args.deliveries}`)
const BODY = JSON.stringify({ object_kind: 'merge_request', perf: 'x'.repeat(512) })
for (let base = 0; base < args.deliveries; base += RUN_CHUNK) {
  const hi = Math.min(base + RUN_CHUNK, args.deliveries)
  tx(() => {
    const ins = raw.prepare(
      `INSERT OR IGNORE INTO webhook_deliveries
         (id, endpoint_id, event_uuid, object_kind, event_type, status, received_at, body_json)
       VALUES (?, 'perf-endpoint', ?, 'merge_request', 'merge_request', 'matched', ?, ?)`,
    )
    for (let i = base; i < hi; i += 1) {
      ins.run(`perfdlv${pad(i, 8)}`, `uuid-${i}`, T0 + ((i * 31) % SPAN), BODY)
    }
  })
  console.log(`[perf-seed]   deliveries ${hi}/${args.deliveries}`)
}

raw.exec('PRAGMA synchronous = NORMAL;')
raw.exec('PRAGMA wal_checkpoint(TRUNCATE);')
raw.exec('ANALYZE;')
raw.close()

const sizeMb = (Bun.file(args.db).size / 1024 / 1024).toFixed(0)
console.log(
  `[perf-seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${sizeMb}MB at ${args.db}`,
)

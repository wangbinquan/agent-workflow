// RFC-311 T30 — proposal §6 指标实测(对 perf-seed 生成的基准库跑 HTTP 端点)。
//
//   bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db
//   bun run scripts/perf-bench.ts --db /tmp/aw-perf/agent-workflow.db
//
// 走 createApp + app.request(与生产同一条中间件/路由/服务链,不绕过鉴权),
// 每个端点跑 N 轮报 p50/p95/max。§6 编号对照打在每行输出上。归档轮(§6.5)
// 单独计时 archiveEvents 一轮。不进 CI 门禁——数字记录进
// design/RFC-311-*/bench-results.md。

/* eslint-disable no-console */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../packages/backend/src/db/client'
import { archiveEvents } from '../packages/backend/src/services/eventsArchive'
import { createApp } from '../packages/backend/src/server'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const DB_PATH = resolve(flag('db') ?? '/tmp/aw-perf/agent-workflow.db')
const ROUNDS = Number(flag('rounds') ?? 20)
const MIGRATIONS = resolve(import.meta.dir, '..', 'packages', 'backend', 'db', 'migrations')
// perf-seed 落好的确定性只读 PAT(bootstrap 完成后 daemon token 失效)。
const TOKEN = `aws_pat_${'ab'.repeat(32)}`

const tmp = mkdtempSync(join(tmpdir(), 'aw-perf-bench-'))
process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')

const db = openDb({ path: DB_PATH, migrationsFolder: MIGRATIONS })
const app = createApp({
  token: TOKEN,
  configPath: join(tmp, 'config.json'),
  opencodeVersion: '1.14.25',
  dbVersion: 17,
  db,
})

async function timed(path: string): Promise<number> {
  const t0 = performance.now()
  const res = await app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}: ${await res.text()}`)
  await res.arrayBuffer()
  return performance.now() - t0
}

function stats(samples: number[]): { p50: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! }
}

async function bench(label: string, path: string): Promise<void> {
  await timed(path) // 预热(首轮含页缓存冷启动,不计入)
  const samples: number[] = []
  for (let i = 0; i < ROUNDS; i += 1) samples.push(await timed(path))
  const { p50, p95, max } = stats(samples)
  console.log(
    `${label.padEnd(44)} p50=${p50.toFixed(1).padStart(7)}ms  p95=${p95.toFixed(1).padStart(7)}ms  max=${max.toFixed(1).padStart(7)}ms`,
  )
}

console.log(`[perf-bench] db=${DB_PATH} rounds=${ROUNDS}\n`)

// §6.1 /api/tasks/page:默认视图首页 + 翻页 + 切视图。
await bench('§6.1 tasks/page default first page', '/api/tasks/page?limit=50')
const first = await app.request('/api/tasks/page?limit=50', {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
const firstBody = (await first.json()) as { nextCursor: string | null }
if (firstBody.nextCursor !== null) {
  await bench(
    '§6.1 tasks/page second page',
    `/api/tasks/page?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  )
}
await bench('§6.1 tasks/page running view', '/api/tasks/page?limit=50&statuses=running')

// §6.2 /api/cached-repos 分页。
await bench('§6.2 cached-repos first page', '/api/cached-repos?limit=50')
await bench('§6.2 cached-repos referenced view', '/api/cached-repos?limit=50&view=referenced')

// §6.3 三徽章 + overview。
await bench('§6.3 reviews/pending-count', '/api/reviews/pending-count')
await bench('§6.3 clarify/pending-count', '/api/clarify/pending-count')
await bench('§6.3 workgroup-tasks/pending-count', '/api/workgroup-tasks/pending-count')
await bench('§6.3 overview', '/api/overview')

// §6.5 归档器单轮(默认阈值;基准库热点 run 远超 5 万行,必然做功)。
{
  const t0 = performance.now()
  const result = await archiveEvents(
    db,
    {
      eventsArchiveThresholds: {
        perNodeRunRows: 50_000,
        globalRows: 1_000_000,
        perNodeRunBytes: 8 * 1024 * 1024,
        globalBytes: 256 * 1024 * 1024,
      },
    },
    join(tmp, 'logs'),
  )
  const ms = performance.now() - t0
  console.log(
    `${'§6.5 archiveEvents one round'.padEnd(44)} took=${ms.toFixed(1).padStart(7)}ms  archived=${result.perGroupArchived + result.globalArchived}`,
  )
}

console.log('\n[perf-bench] done')
process.exit(0)

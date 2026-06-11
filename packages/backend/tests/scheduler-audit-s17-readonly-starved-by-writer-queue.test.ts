// RFC-098 B1 REGRESSION LOCK — design/scheduler-audit-2026-06-10.md S-17 (WP-5)
// （此文件由修复前的 CURRENT-BEHAVIOR LOCK 按原头注 FLIP 指引翻转而来。）
//
// 修复前的缺陷行为：runOneNode 固定【先 globalSem 后 writeSem】，当就绪写节点数
// ≥ maxConcurrentNodes 时，排队中的写者每人占住一个 global 槽（它们在 writeSem
// 上睡觉但不释放 global），readonly 节点拿不到任何 global 槽，被整体饿死到首个
// 写者完成释放槽位为止——直接违反注释承诺的 "readonly nodes run truly in
// parallel"。Code→Audit→Fix 主场景里 readonly 审计节点因此被迫串行。
//
// 修复后的正确语义（本文件全绿地锁定它）：写节点【先 writeSem 后 globalSem】
// （全局锁序 writeSem ≺ globalSem ≺ subprocessSem，src/services/scheduler.ts
// runOneNode / fanout shard / aggregator 三点同型，释放反序），排队写者睡在
// writeSem 上、不占 global 槽，readonly 节点与首个写者真并行。
//
// 确定性说明（为什么这不是 sleep 竞速）：
//   - 四个节点无边、同帧就绪，dispatch 顺序 = definition.nodes 顺序
//     （deriveFrontier 按 scopeNodes 顺序压 ready；runScope 按 f.ready 顺序
//     同步起 promise）。
//   - Semaphore 是 FIFO（util/semaphore.ts），四个 runOneNode 在 acquire 前的
//     await 链完全同构（全是 agent-single、零边、同形 DB 查询），按起跑顺序到达
//     acquire ⇒ w1 取 writeSem + global 槽 1，w2/w3 睡在 writeSem 上（不占
//     global 槽），readonly auditor 直接拿 global 槽 2 起跑。
//   - 翻转后的断言依旧是结构性的：auditor 不取 writeSem，w1 持锁期间它即拿到
//     第 2 个 global 槽 spawn；每个写者至少跑 WRITER_DELAY_MS=300ms，auditor
//     起跑只需常数管线开销 ⇒ auditor.start < min(写者 end) 有 ~300ms 结构余量，
//     不依赖毫秒级竞速。修复前语义下该断言稳定为红（auditor 只能在首个写者完整
//     结束后才有槽）。
//   - 用 3 个写者 + capacity 2：即使排队顺序出现 ±1 扰动，readonly 真并行的
//     结论不变；写者两两不重叠的支撑断言保持原样。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const WRITER_DELAY_MS = 300

// Minimal opencode stand-in generated into the temp dir (fixtures/mock-opencode
// has no per-agent delay knob and this file must not modify shared fixtures).
// Contract mirrored from fixtures/mock-opencode.ts: argv 'run' + --agent NAME,
// JSON text event on stdout carrying the <workflow-output> envelope, exit 0.
// It appends {agent, phase: start|end, t} trace lines so the test can compare
// actual subprocess lifetimes (start = spawn reached, end = just before exit).
const GATED_MOCK_SOURCE = `
import process from 'node:process'
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('gated-mock 1.0.0\\n')
  process.exit(0)
}
const i = argv.indexOf('--agent')
const agent = i >= 0 ? (argv[i + 1] ?? '') : ''
const trace = process.env.S17_TRACE_FILE ?? ''
appendFileSync(trace, JSON.stringify({ agent, phase: 'start', t: Date.now() }) + '\\n')
const delay = Number(process.env['S17_DELAY_MS_FOR_' + agent] ?? '0')
if (Number.isFinite(delay) && delay > 0) await Bun.sleep(delay)
const text =
  '<workflow-output>\\n  <port name="summary">done-' + agent + '</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n',
)
appendFileSync(trace, JSON.stringify({ agent, phase: 'end', t: Date.now() }) + '\\n')
process.exit(0)
`

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  mockPath: string
  tracePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-s17-starve-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const mockPath = join(appHome, 'gated-opencode.ts')
  writeFileSync(mockPath, GATED_MOCK_SOURCE)
  const tracePath = join(appHome, 'trace.jsonl')
  writeFileSync(tracePath, '')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    mockPath,
    tracePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, readonly: boolean): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['summary']),
    readonly,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

interface TraceEvent {
  agent: string
  phase: 'start' | 'end'
  t: number
}

function readTrace(path: string): TraceEvent[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TraceEvent)
}

describe('S-17 — queued writers no longer hold global slots; readonly runs parallel to the first writer (RFC-098 B1 regression lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('with maxConcurrentNodes=2, a ready readonly node starts BEFORE the first writer completes', async () => {
    // Definition order drives dispatch order: w1, w2 take the 2 global
    // slots, w3 queues on writeSem holding a would-be slot request, and the
    // readonly auditor sits behind all of them on globalSem.
    await seedAgent(h.db, 'w1', false)
    await seedAgent(h.db, 'w2', false)
    await seedAgent(h.db, 'w3', false)
    await seedAgent(h.db, 'auditor', true)
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'w1', kind: 'agent-single', agentName: 'w1' },
        { id: 'w2', kind: 'agent-single', agentName: 'w2' },
        { id: 'w3', kind: 'agent-single', agentName: 'w3' },
        { id: 'r', kind: 'agent-single', agentName: 'auditor' },
      ],
      edges: [],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(def),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      name: 'fixture-task',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/repo',
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })

    await withEnv(
      {
        S17_TRACE_FILE: h.tracePath,
        S17_DELAY_MS_FOR_w1: String(WRITER_DELAY_MS),
        S17_DELAY_MS_FOR_w2: String(WRITER_DELAY_MS),
        S17_DELAY_MS_FOR_w3: String(WRITER_DELAY_MS),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.mockPath],
          maxConcurrentNodes: 2,
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const trace = readTrace(h.tracePath)
    const startOf = (agent: string) => trace.find((e) => e.agent === agent && e.phase === 'start')
    const endOf = (agent: string) => trace.find((e) => e.agent === agent && e.phase === 'end')
    for (const a of ['w1', 'w2', 'w3', 'auditor']) {
      expect(startOf(a)).toBeDefined()
      expect(endOf(a)).toBeDefined()
    }

    // Supporting invariant (already locked by scheduler.test.ts:622 via wall
    // clock): the three writers serialize on writeSem — their subprocess
    // lifetimes are pairwise non-overlapping.
    const writers = ['w1', 'w2', 'w3']
    for (const a of writers) {
      for (const b of writers) {
        if (a >= b) continue
        const disjoint = endOf(a)!.t <= startOf(b)!.t || endOf(b)!.t <= startOf(a)!.t
        expect(disjoint).toBe(true)
      }
    }

    // HEADLINE LOCK (flipped on RFC-098 B1): writers acquire writeSem BEFORE
    // a global slot, so queued writers don't hold slots — the readonly
    // auditor (ready since tick one, zero-delay, no write lock needed) is
    // spawned WHILE the first writer is still running, i.e. it truly runs in
    // parallel: auditor.start < min(writer ends) with ~WRITER_DELAY_MS of
    // structural margin. (Pre-fix this was >= — the starvation defect.)
    const earliestWriterEnd = Math.min(...writers.map((w) => endOf(w)!.t))
    const auditorStart = startOf('auditor')!.t
    expect(auditorStart).toBeLessThan(earliestWriterEnd)
  }, 20_000)
})

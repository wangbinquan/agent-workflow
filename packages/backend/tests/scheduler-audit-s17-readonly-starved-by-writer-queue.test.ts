// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-17 (WP-5)
//
// 当前缺陷行为（已对照 src/services/scheduler.ts:1462-1463 核实）：
//   runOneNode 固定【先 globalSem 后 writeSem】：
//     const releaseGlobal = await globalSem.acquire()      // :1462
//     const releaseWrite  = agent.readonly ? null : await writeSem.acquire()  // :1463
//   当就绪写节点数 ≥ maxConcurrentNodes 时，排队中的写者每人占住一个 global 槽
//   （它们在 writeSem 上睡觉但不释放 global），readonly 节点拿不到任何 global 槽，
//   被整体饿死到首个写者完成释放槽位为止——直接违反 :567-568 注释承诺的
//   "readonly nodes run truly in parallel"。Code→Audit→Fix 主场景里 readonly
//   审计节点因此被迫串行，墙钟成倍膨胀。
//
// 正确语义应是：写节点先取 writeSem 再取 globalSem（fanout shard / aggregator
// 同步改，scheduler.ts:2915-2917 / 3098-3100 同型），排队写者不占 global 槽，
// readonly 与首个写者真并行。
//
// 修复归属：WP-5（任务级写锁注册表 + 信号量取用顺序）。
// 修复时本文件应翻红：最后的 starvation 断言（r.start >= 最早写者 end）不再成立
// ——届时翻转为断言 readonly 的 start 早于所有写者的 end（真并行）。
//
// 确定性说明（为什么这不是 sleep 竞速）：
//   - 四个节点无边、同帧就绪，dispatch 顺序 = definition.nodes 顺序
//     （deriveFrontier 按 scopeNodes 顺序压 ready，scheduler.ts:1106-1127；
//     runScope 按 f.ready 顺序同步起 promise，:633-640）。
//   - Semaphore 是 FIFO（util/semaphore.ts），四个 runOneNode 在 acquire 前的
//     await 链完全同构（全是 agent-single、零边、同形 DB 查询），按起跑顺序到达
//     acquire ⇒ w1/w2 占满 2 个槽，w3、readonly 排队。
//   - 断言本身是结构性的：readonly 的 spawn 只能发生在某个写者 runOneNode 完整
//     结束（进程退出 + 终态落库）释放 global 槽之后，因此
//     readonly.start >= min(写者 end) 与计时器精度无关；写者 300ms 延迟只是为了
//     修复后（readonly 与 w1 并行）该断言能稳定翻红。
//   - 用 3 个写者 + capacity 2：即使排队顺序出现 ±1 扰动（readonly 插到 w3 前），
//     readonly 仍要等首个写者完成才有槽，断言依旧成立——不依赖毫秒级竞速。

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

describe('S-17 — queued writers hold global slots and starve readonly nodes (current-behavior lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('with maxConcurrentNodes=2, a ready readonly node does not start until the first writer COMPLETES', async () => {
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

    // DEFECT LOCK (the S-17 claim): the readonly auditor — ready since tick
    // one, zero-delay, no write lock needed — is spawned only AFTER the
    // earliest writer has fully completed and released its global slot.
    // Under the promised semantics (writers acquire writeSem BEFORE a global
    // slot / queued writers don't hold slots) the auditor would run in
    // parallel with the first writer, i.e. auditor.start < min(writer ends)
    // by ~WRITER_DELAY_MS. Flip this assertion when WP-5 lands:
    //   expect(auditorStart).toBeLessThan(earliestWriterEnd)
    const earliestWriterEnd = Math.min(...writers.map((w) => endOf(w)!.t))
    const auditorStart = startOf('auditor')!.t
    expect(auditorStart).toBeGreaterThanOrEqual(earliestWriterEnd)
  }, 20_000)
})

// RFC-314 D3 —— 事件落库按 chunk 合并。
//
// 这条测试为什么存在：`runner.ts` 原本每读到一行 stdout/stderr 就发一条 autocommit
// INSERT（外加一次重试包装）。20 个 agent 并发猛吐时，语句数与 -wal 帧数按**行数**线性
// 增长。合并的边界取 pump 的 chunk 边界——它是唯一一个既天然存在、又**不引入新的持久化
// 延迟**的边界：`onChunkEnd` 在同一个 await 内写完才让出事件循环，pump 的下一次 read
// 之前一定已落库，所以读点（countAgentTextEvents / 会话租约 retag / WS 回放）不需要任何
// flush 屏障。
//
// 三组判据：
//   ① pump 的 chunk 边界回调时机（确定性单测：chunk 由测试自己切）；
//   ② 端到端合并确实发生（同一批事件的 INSERT 语句数远少于行数），且事件内容 / 顺序 /
//      id 单调性与逐行写入一致；
//   ③ 抛错那一批的取证事件不丢——取证日志恰恰在失败时最重要。**变异检验的如实记录**：
//      单去掉 runner 的 catch-flush，这条判据仍绿（进程返回后的兜底冲刷同样会写下去），
//      所以另配了一条源代码层断言当地板，理由写在那条用例上方。

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { pump } from '../src/services/execution/managedProcess'
import { runNode } from './helpers/runner'
import { recordStatements } from './helpers/statementRecorder'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// ---------------------------------------------------------------------------
// ① pump 的 chunk 边界
// ---------------------------------------------------------------------------

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i += 1
    },
  })
}

describe('RFC-314 D3 —— pump 的 chunk 边界回调', () => {
  test('每个 chunk 的行投递完调一次，EOF 收尾行之后再调一次', async () => {
    const trace: string[] = []
    const p = pump(
      // 三个 chunk：两行一批 / 三行一批 / 一个没有换行的尾巴（EOF 时才成行）
      streamOf(['a\nb\n', 'c\nd\ne\n', 'tail-without-newline']),
      (line) => {
        trace.push(`line:${line}`)
      },
      undefined,
      undefined,
      () => {
        trace.push('chunk-end')
      },
    )
    await p.done

    expect(trace).toEqual([
      'line:a',
      'line:b',
      'chunk-end',
      'line:c',
      'line:d',
      'line:e',
      'chunk-end',
      // 第三个 chunk 里没有完整行 —— 边界仍然到达（此时冲刷是空操作）
      'chunk-end',
      'line:tail-without-newline',
      'chunk-end',
    ])
  })

  test('不传 onChunkEnd 时行为逐字不变（其余四个调用方的形态）', async () => {
    const lines: string[] = []
    const p = pump(streamOf(['x\ny\n', 'z']), (line) => void lines.push(line), undefined)
    await p.done
    expect(lines).toEqual(['x', 'y', 'z'])
  })
})

// ---------------------------------------------------------------------------
// ②③ runner 端到端
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: 'an agent',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You are a test agent.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc314-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc314-fixture',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'node1', status: 'pending' })
  return id
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

describe('RFC-314 D3 —— 端到端', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('一批事件合并成远少于行数的 INSERT，内容 / 顺序 / id 单调性不变', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const EVENTS = 30
    const raw = (h.db as unknown as { $client: Parameters<typeof recordStatements>[0] }).$client
    const rec = recordStatements(raw)
    try {
      await withEnv(
        {
          MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
          MOCK_OPENCODE_EVENTS: JSON.stringify(
            Array.from({ length: EVENTS }, (_, i) => ({ type: 'text', text: `chunk-line-${i}` })),
          ),
        },
        () =>
          runNode({
            taskId: h.taskId,
            nodeRunId,
            nodeId: 'node1',
            agent: makeAgent(),
            inputs: {},
            worktreePath: h.worktreePath,
            templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
            skills: [],
            appHome: h.appHome,
            binaryOverride: ['bun', 'run', MOCK_OPENCODE],
            db: h.db,
          }),
      )
    } finally {
      rec.stop()
    }

    // 事件全部落库，且顺序（按 id）与 agent 的输出顺序一致 —— 合并不改内容也不改顺序。
    const rows = await h.db
      .select({ id: nodeRunEvents.id, payload: nodeRunEvents.payload })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunEvents.id))
    const texts = rows
      .map((r) => {
        try {
          return (JSON.parse(r.payload) as { text?: string }).text ?? ''
        } catch {
          return ''
        }
      })
      .filter((t) => t.startsWith('chunk-line-'))
    expect(texts).toEqual(Array.from({ length: EVENTS }, (_, i) => `chunk-line-${i}`))
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.id).toBeGreaterThan(rows[i - 1]!.id)

    // 合并确实发生了：这一批 30 行事件所用的 INSERT 语句数远少于 30。
    const eventInserts = rec.statements.filter((s) =>
      /^\s*insert\s+into\s+"node_run_events"/i.test(s.sql),
    )
    expect(eventInserts.length).toBeGreaterThan(0)
    expect(
      eventInserts.length,
      `事件 INSERT 语句 ${eventInserts.length} 条 —— 逐行写入会是 ${EVENTS} 条量级`,
    ).toBeLessThan(EVENTS / 2)
    // 每条语句的绑定参数远低于仓内 900 护栏线（SQLite 硬上限 32766）。
    for (const stmt of eventInserts) expect(stmt.params).toBeLessThanOrEqual(900)
  }, 20_000)

  // 变异检验的如实记录：把 runner 里的 catch-flush 去掉，这条**仍然绿**——因为进程返回
  // 后还有一道兜底冲刷（取消 / kill 时 pump 走 `cancel()` 而不是 EOF，那道兜底本来就是
  // 为它准备的）。所以下面这条锁的是**结果**（抛错那一批的取证事件不丢），不是 catch-flush
  // 本身；catch-flush 的价值是把落库提前到 kill/reap 那几秒之前（daemon 在那期间崩掉就
  // 只剩它兜底），而进程内测试观察不到这个差别，故另配一条源代码层断言当地板。
  test('某一行抛错时，那一批的取证事件不会丢', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    // 第二条事件换了 native session id 且没有声明 conversation reset ⇒ runner 抛
    // 'runtime changed native session id without a conversation reset'。第一条事件
    // 此刻还在缓冲区里——它必须被冲刷下去。
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: JSON.stringify([
          { type: 'text', text: 'FORENSIC-BEFORE-THROW', sessionID: 'ses-one' },
          { type: 'text', text: 'after', sessionID: 'ses-two' },
        ]),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'node1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )

    const rows = await h.db
      .select({ payload: nodeRunEvents.payload })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(
      rows.some((r) => r.payload.includes('FORENSIC-BEFORE-THROW')),
      '抛错那一批的取证事件丢了',
    ).toBe(true)
  }, 20_000)

  // 源代码层地板：三个冲刷点缺一不可，而其中两个在进程内测不出差别（见上）。
  // ① 抛错前冲刷（把落库提前到 kill/reap 之前）；
  // ② 会话轮换**之前**冲刷（`rotateRuntimeSessionLease` 会回标已落库的旧 epoch 事件，
  //    缓冲行晚于它落库就会带着旧 sessionId 落进孤儿桶）；
  // ③ 进程返回后兜底冲刷（取消 / kill 走 `cancel()`，拿不到 EOF 的 chunk-end）。
  test('runner 的三个冲刷点都在（源代码层地板）', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf-8',
    )
    expect(src).toContain('await flushEventsBeforeThrow()')
    const rotateIdx = src.indexOf("persistRunnerWrite('runtime-session-lease/rotate'")
    expect(rotateIdx).toBeGreaterThan(0)
    // 轮换那条语句之前 400 字符内必须有一次 stdout 冲刷。
    expect(src.slice(Math.max(0, rotateIdx - 400), rotateIdx)).toContain(
      'await stdoutEvents.flush()',
    )
    // 进程返回后的兜底：两条流都要冲。
    expect(src).toContain('await stdoutEvents.flush()\n    await stderrEvents.flush()')
  })
})

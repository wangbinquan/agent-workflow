// RFC-042 §A4 / §5.4 — default retries fallback = 3.
//
// Locks in: when no per-task retry budget is supplied, the scheduler treats it
// as 3 (not 0). RFC-115: the budget moved from a per-node `retries` override to
// the global config.defaultNodeRetries (threaded via runTask opts). Explicit
// values still win; absence falls back to 3.
//
// We drive runTask with mock-opencode set to "always fail / always skip
// envelope" and count invocations to read the effective retry budget out of
// observed behavior. Counting invocations is more honest than reading the
// scheduler source because it exercises the actual code path including any
// future refactors.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function makeHarness() {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc042-default-retries-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    argvLog,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: '',
    outputs: JSON.stringify(['design']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedTask(h: ReturnType<typeof makeHarness>, def: WorkflowDefinition) {
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
    name: 'fixture',
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
  return taskId
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

async function runScenario(
  retries: number | undefined,
  h: ReturnType<typeof makeHarness>,
): Promise<number> {
  const agentId = await seedAgent(h.db, 'agent1')
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      {
        id: 'n1',
        kind: 'agent-single',
        agentId,
        agentName: 'agent1',
      },
    ],
    edges: [],
  }
  const taskId = await seedTask(h, def)
  await withEnv(
    {
      MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
      MOCK_OPENCODE_EXIT_CODE: '9',
      MOCK_OPENCODE_SKIP_ENVELOPE: '1',
    },
    () =>
      // RFC-115: the retry budget is global now (was the per-node `retries`
      // override) — drive it through runTask's defaultNodeRetries; omitted →
      // scheduler fallback 3. The mock crashes (exit 9 + skip envelope) so every
      // attempt fails and we count one opencode invocation per attempt.
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        ...(retries !== undefined ? { defaultNodeRetries: retries } : {}),
        // RFC-313 AC-5: 本文件锁的是 RFC-042 的 fallback=3 契约，即升级开关关闭时的
        // attempt 数。置 0 让它继续充当那份不变量证据——断言一个字未改。开关打开后的
        // 上限（乘积）由 rfc313-session-escalation.test.ts 单独锁。
        sessionRestartBudget: 0,
      }),
  )
  const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  expect(t?.status).toBe('failed')
  return readFileSync(h.argvLog, 'utf8').trim().split('\n').filter(Boolean).length
}

// 墙钟预算（RFC-287 T1 期实测补）：每条 scenario 要**串行 spawn N 个真实子进程**
// （N = 1 + retries），bun 默认 5s 在四分片满载的门禁机上对 N≥4 是擦边值——实测
// 会先让 6-attempt 那条超时，而同 describe 共享 harness/argv 日志，超时后的残留
// 写入会把后一条的断言带偏（收到 'done' 而非 'failed'），表现成两条无关的红。
// 下面按 attempt 数给显式预算：这是**墙钟允许量**，不是对调度变慢的容忍——若哪天
// 单次 attempt 真的变慢，该由 attempt 级的断言/计时去发现，而不是靠这里超时。
const BUDGET_PER_ATTEMPT_MS = 4_000

describe('RFC-042 default retries fallback = 3', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.cleanup())

  test('a pre-spawn exception catch terminalizes its node_run before retry dispatch', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    const thrownResult = source.indexOf('const errorMessage = `node ${node.id} threw: ${msg}`')
    expect(thrownResult).toBeGreaterThan(0)
    const catchStart = source.lastIndexOf('} catch (err) {', thrownResult)
    const catchBody = source.slice(catchStart, thrownResult + 1_600)
    expect(catchBody).toContain("event: { kind: 'mark-failed'")
    expect(catchBody).toContain('finishedAt: Date.now()')
    expect(catchBody).toContain('broadcastNodeStatus')
  })

  test(
    'omitted retries → 4 attempts (1 + 3 retries)',
    async () => {
      const n = await runScenario(undefined, h)
      expect(n).toBe(4)
    },
    4 * BUDGET_PER_ATTEMPT_MS,
  )

  test(
    'defaultNodeRetries=0 honored verbatim → 1 attempt',
    async () => {
      const n = await runScenario(0, h)
      expect(n).toBe(1)
    },
    1 * BUDGET_PER_ATTEMPT_MS,
  )

  test(
    'defaultNodeRetries=5 honored verbatim → 6 attempts',
    async () => {
      const n = await runScenario(5, h)
      expect(n).toBe(6)
    },
    6 * BUDGET_PER_ATTEMPT_MS,
  )

  test(
    'defaultNodeRetries=1 honored verbatim → 2 attempts',
    async () => {
      const n = await runScenario(1, h)
      expect(n).toBe(2)
    },
    2 * BUDGET_PER_ATTEMPT_MS,
  )
})

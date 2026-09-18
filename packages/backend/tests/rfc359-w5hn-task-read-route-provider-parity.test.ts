// RFC-359 AC-1 / AC-6（plan §5hn 之后的盘点，第 1 刀）—— **任务详情的纯读四件**在两个引擎上
// 投影出同一份。
//
// 为什么这条测试存在：启动面已经全合（批次一 / 二 ①–⑧）。`TaskRouteOperations` 这一对剩下的是
// 「任务路由的其余动词」——SQLite 那 276 行全是转给 `services/task.ts` 的薄壳，PostgreSQL 那
// 2555 行是原生实现。合它之前先把等价性钉住，这是前八刀验证过的次序。
//
// 这一刀取**差异面最小**的一组：`node-runs` 的投影。它不需要真跑任务——直接把 `node_runs` /
// `doc_versions` / `clarify_rounds` 播种成确定的形状，读的就是投影本身，
// 而投影正是这一对唯一可能分叉的地方（PG 那侧自带评审轮次计时、clarify 轮次、nav kind）。
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, docVersions, nodeRunEvents, nodeRuns, tasks } from '@/db/schema'
import { runGit } from '@/util/git'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const TOKEN = 'r'.repeat(64)
const NOW = 1_788_278_400_000

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

async function createAgent(app: Hono, name: string): Promise<string> {
  const res = await req(app, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'rfc359 read parity',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/** 两节点：一个 agent（跑完）、一个 review（等人审）。几何写成非规范值。 */
function definitionFor(writerAgentId: string) {
  return {
    $schema_version: 5,
    inputs: [],
    nodes: [
      {
        id: 'writer',
        kind: 'agent-single',
        agentId: writerAgentId,
        agentName: 'writer',
        promptTemplate: 'write it',
        position: { x: 71, y: 233 },
      },
    ],
    edges: [],
  }
}

/** 逐次必然不同的那几格。其余整条响应体都比。 */
const VOLATILE_RUN_KEYS = new Set(['taskId'])

function comparableRuns(body: Record<string, unknown>): unknown {
  const runs = (body['runs'] as ReadonlyArray<Record<string, unknown>>).map((run) => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(run).sort()) {
      if (VOLATILE_RUN_KEYS.has(key)) continue
      out[key] = run[key]
    }
    return out
  })
  return { runs, outputs: body['outputs'] }
}

const projected = new Map<string, unknown>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 任务 node-runs 投影的两个引擎对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-read-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一批 node_runs / doc_versions / clarify_rounds：两个引擎投影出同一份 node-runs', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const writerId = await createAgent(app, `read-writer-${suffix}`)
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `read-wf-${suffix}`,
          description: 'rfc359 read parity',
          definition: definitionFor(writerId),
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const launched = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          name: 'rfc359 read parity',
          scratch: true,
        }),
      })
      expect(launched.status, await launched.clone().text()).toBe(201)
      const taskId = String(((await launched.json()) as { id: string }).id)

      // **确定形状的播种**：三条 run 覆盖三种时间线位置（未开始 / 跑完 / 等人审），
      // 外加一条评审版本与一条 clarify 轮次，把 PG 那侧独有的派生（轮次计时 / nav kind /
      // clarify 状态）全都点亮——分叉只可能在这些派生里。
      await scope.harness.db.insert(nodeRuns).values([
        {
          id: 'rr-pending-0001',
          taskId,
          nodeId: 'writer',
          status: 'pending',
          retryIndex: 0,
          iteration: 0,
          operationGeneration: 0,
        },
        {
          id: 'rr-done-0001',
          taskId,
          nodeId: 'writer',
          status: 'done',
          retryIndex: 0,
          iteration: 1,
          startedAt: NOW,
          finishedAt: NOW + 1_000,
          operationGeneration: 0,
        },
        {
          id: 'rr-review-0001',
          taskId,
          nodeId: 'writer',
          status: 'awaiting_review',
          retryIndex: 0,
          iteration: 2,
          startedAt: NOW + 2_000,
          operationGeneration: 0,
        },
      ])
      await scope.harness.db.insert(docVersions).values({
        id: 'dv-0001',
        taskId,
        reviewNodeId: 'writer',
        reviewNodeRunId: 'rr-review-0001',
        sourceNodeId: 'writer',
        sourcePortName: 'report',
        versionIndex: 1,
        itemIndex: 0,
        roundGeneration: 0,
        reviewIteration: 0,
        bodyPath: 'reviews/dv-0001.md',
        decision: 'pending',
        createdAt: NOW + 2_500,
      })
      await scope.harness.db.insert(clarifyRounds).values({
        id: 'cr-0001',
        taskId,
        kind: 'self',
        askingNodeId: 'writer',
        askingNodeRunId: 'rr-done-0001',
        intermediaryNodeId: 'writer',
        intermediaryNodeRunId: 'rr-done-0001',
        questionsJson: '[]',
        status: 'answered',
        createdAt: NOW + 900,
      })

      const res = await req(app, `/api/tasks/${taskId}/node-runs`)
      expect(res.status, await res.clone().text()).toBe(200)
      const body = (await res.json()) as Record<string, unknown>

      // 先钉住这一侧**本身**的正确性——两个引擎同样地错也会让相等断言绿掉。
      const runs = body['runs'] as ReadonlyArray<Record<string, unknown>>
      expect(
        runs.map((run) => run['id']),
        '未开始的那条必须排在最前（两个引擎的 NULL 默认落位相反）',
      ).toEqual(['rr-pending-0001', 'rr-done-0001', 'rr-review-0001'])

      projected.set(scope.harness.capabilities.provider, comparableRuns(body))
      if (projected.size < 2) return
      expect(
        projected.get('postgresql'),
        '两个引擎的 node-runs 投影不一致（plan §5hn 之后的盘点，第 1 刀）',
      ).toEqual(projected.get('sqlite'))
    })
  },
)

// ---------------------------------------------------------------------------
// RFC-359 AC-1 / AC-6（plan §5hn 之后的盘点，第 2 刀）—— 纯读的另外三件：
// `diff` / `stdout` / `events`。
//
// 与第 1 刀同样的次序：**先把等价性钉住，再合并**。合并前这三件在两个引擎上是两份独立源码
// （SQLite 侧 `services/task.ts` 的 `getTaskDiff` / `getNodeRunStdout` / `getNodeRunEvents`，
// PostgreSQL 侧 `taskRouteOperations.ts` 的 `taskDiff` / `nodeRunStdout` /
// `nodeRunEventsPage`），逐字读下来算法一致，但 `diff` 的**单仓 410 文案**是真分叉：
// SQLite 分「目录还在但已不是 git 仓」与「目录根本不存在」两句话，PostgreSQL 只有一句
// 「unavailable」。当时把这两格显式钉成分叉，合并后它自己红了，于是改成相等断言——账已销，
// 三件现在共用 `taskDiffProjection` / `nodeRunStdoutProjection` / `nodeRunEventsProjection`。
//
// 为什么要连 `stdout` / `events` 一起：它们和 `diff` 是同一段 `createXxxTaskRouteOperations`
// 里挨着的三行，一次合完才不会留下「合了一半」的中间态；而且它们读的是 `node_run_events`
// ——那张表的排序 / 分页在两种数据库上默认行为相反（SQLite 的 `AUTOINCREMENT` 与 PG 的
// `bigserial` 都单调，但 NULL / 并列时的默认落位不同），值得各自钉一条。

/** 起一个只有一个 agent 节点的工作流 + 一个 scratch 任务，回任务 id。 */
async function launchReadFixtureTask(app: Hono, label: string): Promise<string> {
  const suffix = ulid().slice(-8).toLowerCase()
  const writerId = await createAgent(app, `${label}-${suffix}`)
  const wfRes = await req(app, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `${label}-wf-${suffix}`,
      description: 'rfc359 read parity',
      definition: definitionFor(writerId),
    }),
  })
  expect(wfRes.status, await wfRes.clone().text()).toBe(201)
  const workflow = (await wfRes.json()) as { id: string }
  const launched = await req(app, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ workflowId: workflow.id, name: label, scratch: true }),
  })
  expect(launched.status, await launched.clone().text()).toBe(201)
  return String(((await launched.json()) as { id: string }).id)
}

/** 播种一条 node_run，回它的 id。 */
async function seedRun(db: ProviderNeutralDatabase, taskId: string, id: string): Promise<string> {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'writer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    operationGeneration: 0,
    startedAt: NOW,
    finishedAt: NOW + 1_000,
  })
  return id
}

/**
 * 一条 stdout 事件流：混 stderr（必须被 stdout 视图丢掉、却要出现在 events 视图里）、
 * 非 ASCII（字节 vs 字符的预算口径分叉只在这里看得见）、以及一条 JSON payload
 * （events 视图要把它解析成对象，stdout 视图要原样当文本）。
 */
const READ_EVENT_ROWS = [
  { kind: 'text' as const, payload: 'first line' },
  { kind: 'stderr' as const, payload: 'noise on the error channel' },
  { kind: 'text' as const, payload: '第二行——中文与 emoji 🚀 一起进预算' },
  { kind: 'tool_use' as const, payload: '{"tool":"read","path":"a.ts"}' },
  { kind: 'text' as const, payload: 'last line' },
]

async function seedReadEvents(db: ProviderNeutralDatabase, nodeRunId: string): Promise<void> {
  await db.insert(nodeRunEvents).values(
    READ_EVENT_ROWS.map((row, index) => ({
      nodeRunId,
      ts: NOW + index,
      kind: row.kind,
      payload: row.payload,
    })),
  )
}

const stdoutProjected = new Map<string, unknown>()
const eventsProjected = new Map<string, unknown>()
const diffProjected = new Map<string, unknown>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 任务纯读 diff / stdout / events 的两个引擎对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-read3-',
  },
  (scope) => {
    let app: Hono
    const scratchDirs: string[] = []

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    afterEach(() => {
      for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    test('同一批 node_run_events：两个引擎的 stdout 尾巴逐字相同（含 stderr 剔除）', async () => {
      const taskId = await launchReadFixtureTask(app, 'read-stdout')
      const runId = await seedRun(scope.harness.db, taskId, `rs-${ulid().slice(-10)}`)
      await seedReadEvents(scope.harness.db, runId)

      const res = await req(app, `/api/tasks/${taskId}/nodes/${runId}/stdout`)
      expect(res.status, await res.clone().text()).toBe(200)
      const text = await res.text()

      // 先钉住这一侧本身的正确性——两个引擎同样地错也会让相等断言绿掉。
      expect(text, 'stderr 不进 stdout 视图；其余按 id 升序换行拼接').toBe(
        [
          'first line',
          '第二行——中文与 emoji 🚀 一起进预算',
          '{"tool":"read","path":"a.ts"}',
          'last line',
        ].join('\n'),
      )

      // 归属门：别的任务下的 run id 一律 404（两个引擎同码同文案）。
      const otherTaskId = await launchReadFixtureTask(app, 'read-stdout-other')
      const foreign = await req(app, `/api/tasks/${otherTaskId}/nodes/${runId}/stdout`)
      expect(foreign.status).toBe(404)
      const foreignBody = (await foreign.json()) as Record<string, unknown>

      stdoutProjected.set(scope.harness.capabilities.provider, {
        text,
        foreignStatus: foreign.status,
        foreignCode: foreignBody['code'],
      })
      if (stdoutProjected.size < 2) return
      expect(
        stdoutProjected.get('postgresql'),
        '两个引擎的 node-run stdout 不一致（plan §5hn 之后的盘点，第 2 刀）',
      ).toEqual(stdoutProjected.get('sqlite'))
    })

    test('同一批 node_run_events：两个引擎的 events 分页 / 游标 / payload 解析逐字相同', async () => {
      const taskId = await launchReadFixtureTask(app, 'read-events')
      const runId = await seedRun(scope.harness.db, taskId, `re-${ulid().slice(-10)}`)
      await seedReadEvents(scope.harness.db, runId)

      const firstRes = await req(app, `/api/tasks/${taskId}/node-runs/${runId}/events?limit=3`)
      expect(firstRes.status, await firstRes.clone().text()).toBe(200)
      const first = (await firstRes.json()) as {
        events: ReadonlyArray<Record<string, unknown>>
        cursor: number | null
      }

      // 本侧正确性：limit 截断、游标 = 本页最后一条、stderr **留在** events 视图里、
      // JSON payload 被解析成对象而纯文本保持字符串。
      expect(first.events.map((event) => event['kind'])).toEqual(['text', 'stderr', 'text'])
      expect(first.cursor).toBe(first.events.at(-1)?.['id'] as number)

      const nextRes = await req(
        app,
        `/api/tasks/${taskId}/node-runs/${runId}/events?since=${String(first.cursor)}`,
      )
      expect(nextRes.status, await nextRes.clone().text()).toBe(200)
      const next = (await nextRes.json()) as {
        events: ReadonlyArray<Record<string, unknown>>
        cursor: number | null
      }
      expect(next.events.map((event) => event['kind'])).toEqual(['tool_use', 'text'])
      expect(next.events[0]?.['payload'], 'JSON payload 解析成对象').toEqual({
        tool: 'read',
        path: 'a.ts',
      })

      const foreignTaskId = await launchReadFixtureTask(app, 'read-events-other')
      const foreign = await req(app, `/api/tasks/${foreignTaskId}/node-runs/${runId}/events`)
      expect(foreign.status).toBe(404)

      // id 是自增主键，两个引擎的绝对值不必相同——比的是**相对形状**。
      const baseId = first.events[0]?.['id'] as number
      const shapeOf = (events: ReadonlyArray<Record<string, unknown>>): unknown =>
        events.map((event) => ({
          offset: (event['id'] as number) - baseId,
          // `nodeRunId` 每次播种都是新 ULID——先钉住它**回的就是这条 run**，再从比较面移走。
          ownedByRun: event['nodeRunId'] === runId,
          ts: event['ts'],
          kind: event['kind'],
          payload: event['payload'],
        }))
      eventsProjected.set(scope.harness.capabilities.provider, {
        first: shapeOf(first.events),
        firstCursorOffset: (first.cursor as number) - baseId,
        next: shapeOf(next.events),
        nextCursorOffset: (next.cursor as number) - baseId,
        foreignStatus: foreign.status,
        foreignCode: ((await foreign.json()) as Record<string, unknown>)['code'],
      })
      if (eventsProjected.size < 2) return
      expect(
        eventsProjected.get('postgresql'),
        '两个引擎的 node-run events 分页不一致（plan §5hn 之后的盘点，第 2 刀）',
      ).toEqual(eventsProjected.get('sqlite'))
    })

    test('同一棵工作树：两个引擎的 diff 正文与错误契约（409 / 410）对等', async () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-rfc359-diff-'))
      scratchDirs.push(root)

      // 一棵真 git 工作树：一条提交 + 一处未提交改动 + 一个未跟踪文件。
      const repo = join(root, 'repo')
      mkdirSync(repo)
      await runGit(repo, ['init', '-q', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 'parity@example.com'])
      await runGit(repo, ['config', 'user.name', 'Parity'])
      writeFileSync(join(repo, 'tracked.txt'), 'one\n')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-q', '-m', 'init'])
      const head = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
      writeFileSync(join(repo, 'tracked.txt'), 'two\n')
      writeFileSync(join(repo, 'untracked.txt'), 'new\n')

      // 一个存在但不是 git 仓的目录，以及一个根本不存在的路径。
      const plain = join(root, 'plain')
      mkdirSync(plain)
      const missing = join(root, 'gone')

      const taskId = await launchReadFixtureTask(app, 'read-diff')
      const point = async (worktreePath: string, baseCommit: string | null): Promise<void> => {
        await scope.harness.db
          .update(tasks)
          .set({ worktreePath, baseCommit, repoCount: 1 })
          .where(eq(tasks.id, taskId))
      }

      await point(repo, head)
      const okRes = await req(app, `/api/tasks/${taskId}/diff`)
      expect(okRes.status, await okRes.clone().text()).toBe(200)
      const ok = (await okRes.json()) as Record<string, unknown>
      // 本侧正确性：正文含已跟踪改动与未跟踪新文件，baseCommit 原样回显，未截断。
      expect(ok['baseCommit']).toBe(head)
      expect(ok['truncated']).toBe(false)
      expect(String(ok['diff'])).toContain('tracked.txt')
      expect(String(ok['diff'])).toContain('untracked.txt')

      await point(repo, null)
      const noBase = await req(app, `/api/tasks/${taskId}/diff`)
      expect(noBase.status).toBe(409)
      const noBaseBody = (await noBase.json()) as Record<string, unknown>

      await point(missing, head)
      const gone = await req(app, `/api/tasks/${taskId}/diff`)
      expect(gone.status).toBe(410)
      const goneBody = (await gone.json()) as Record<string, unknown>

      await point(plain, head)
      const notRepo = await req(app, `/api/tasks/${taskId}/diff`)
      expect(notRepo.status).toBe(410)
      const notRepoBody = (await notRepo.json()) as Record<string, unknown>

      // **两门同时失败**：没有 base commit、工作树也没了。这是唯一能观测到「检查次序」的
      // 那一格——两个引擎都必须先报 409（任务在准备阶段就没成，工作树在不在是次要信息）。
      // 少了它，把两道门对调的单侧变异会静静地绿过去（实测如此，于是补上）。
      await point(missing, null)
      const bothBroken = await req(app, `/api/tasks/${taskId}/diff`)
      expect(bothBroken.status, 'base commit 缺失优先于工作树缺失').toBe(409)
      const bothBrokenBody = (await bothBroken.json()) as Record<string, unknown>
      expect(bothBrokenBody['code']).toBe('task-no-base-commit')

      // 任务 id / 临时目录 / HEAD 都是逐次新生成的——归一成占位符，**文案本身留在比较面里**，
      // 因为待销的账正是文案。
      const stable = (value: unknown): unknown =>
        typeof value !== 'string'
          ? value
          : value.split(taskId).join('<task>').split(root).join('<root>').split(head).join('<head>')
      const errorShape = (res: Response, body: Record<string, unknown>): unknown => ({
        status: res.status,
        code: body['code'],
        message: stable(body['message']),
      })

      diffProjected.set(scope.harness.capabilities.provider, {
        diff: stable(ok['diff']),
        baseCommitIsHead: ok['baseCommit'] === head,
        truncated: ok['truncated'],
        noBase: errorShape(noBase, noBaseBody),
        gone: errorShape(gone, goneBody),
        notRepo: errorShape(notRepo, notRepoBody),
        bothBroken: errorShape(bothBroken, bothBrokenBody),
      })

      // **账已销**（本文件上一版把这两格钉成分叉，合并后它自己红了，于是改成相等断言）：
      // 单仓 410 现在两个引擎都分两句话说清原因——「目录根本不存在」与「目录还在、但已不是
      // 有效的 git 仓库（源仓被移动或删除）」是两种完全不同的现场，用户要据此决定是重建
      // 工作树还是去找源仓。合并前 PostgreSQL 把两种都压成一句泛化的 `is unavailable`。
      expect(String(goneBody['message']), '目录不存在').toContain('does not exist')
      expect(String(notRepoBody['message']), '目录在、但不是 git 仓——原因必须说得出来').toContain(
        'is no longer a valid git repository',
      )

      if (diffProjected.size < 2) return
      expect(
        diffProjected.get('postgresql'),
        '两个引擎的 task diff 正文 / 409 / 410 契约不一致（plan §5hn 之后的盘点，第 2 刀）',
      ).toEqual(diffProjected.get('sqlite'))
    })
  },
)

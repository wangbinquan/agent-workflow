import { rimrafDir } from './helpers/cleanup'
// RFC-131 T5 — deferred self-clarify 多轮 scheduler e2e:runTask 端到端驱动
// round1(agent 问)→答→round2(agent 再问)→答(stop)→产出 doc。锁死 01KWDKBS:最终产出
// rerun 的 prompt 同时含 round1+round2 答案(旧 window 判据会丢 round1、导致最终 doc 丢首轮决策)。
//
// 这是 rfc128-p5-bc MULTI-ROUND(service 级 buildClarifyNodeQueueContext)的 scheduler XOR +
// runTask 真实驱动版:覆盖 scheduler.ts 的 deferred→self 选路 + prompt 落到 rerun.promptText,
// 抓 service 级测不到的接线 bug(scheduler 传错 consumerKind/dispatchedRunId/targetIteration)。
//
// mock 不需按调用次数切 stdout:runTask 每轮吐 <workflow-clarify> 就停在 awaiting_human 返回,
// 两次 runTask 之间用 withEnv 换 MOCK_OPENCODE_CLARIFY_BODY 即可让下一轮问不同问题;最后一轮
// 用 MOCK_OPENCODE_OUTPUTS 让 agent 产出 doc。self-clarify 多轮不涉 fanout(与协作者 4220+ 无关)。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { runTask } from '../src/services/scheduler'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const actor = { userId: 'u1', role: 'owner' as const }
const P = 'P'

function clarifyBody(qid: string, title: string, options: string[]) {
  return JSON.stringify({
    questions: [{ id: qid, title, kind: 'single', recommended: true, options }],
  })
}
function ans(qid: string, idx: number, label: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [idx],
    selectedOptionLabels: [label],
    customText: '',
  }
}

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}
async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-t5-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  for (const p of [repoPath, worktreePath]) {
    await runGit(p, ['init', '-b', 'main'])
    await runGit(p, ['config', 'user.email', 't@t.test'])
    await runGit(p, ['config', 'user.name', 't'])
    writeFileSync(join(p, 'r.md'), '# r\n')
    await runGit(p, ['add', '.'])
    await runGit(p, ['commit', '-m', 'init'])
  }
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rimrafDir(appHome),
  }
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
const run = (h: Harness, taskId: string) =>
  runTask({
    taskId,
    db: h.db,
    appHome: h.appHome,
    opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    defaultNodeRetries: 0,
  })

async function selfEntryId(h: Harness, taskId: string, originNodeRunId: string): Promise<string> {
  const rows = await h.db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'self'),
        eq(taskQuestions.originNodeRunId, originNodeRunId),
      ),
    )
  return rows[0]!.id
}

describe('RFC-131 T5 — deferred self-clarify 多轮 scheduler e2e (派生老化累积)', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
    resetBroadcastersForTests()
  })

  test('round1→round2→产出 doc:最终 rerun prompt 同含两轮答案(锁死 01KWDKBS)', async () => {
    await createAgent(h.db, {
      name: 'planner',
      description: '',
      outputs: ['doc'],
      outputKinds: { doc: 'markdown' },
      // NOTE: origin/main 的 createAgent 仍要求 readonly（协作者 RFC-130 PR-C 删 readonly 尚未 commit，
      // 只在其 working tree）。匹配 committed 契约传 readonly；PR-C 落定后此行随全仓一起清理。
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: P, kind: 'agent-single', agentName: 'planner' } as WorkflowNode,
        { id: 'C', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: P, portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: P, portName: '__clarify__' },
          target: { nodeId: 'C', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'C', portName: 'answers' },
          target: { nodeId: P, portName: '__clarify_response__' },
        },
      ],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await h.db
      .insert(workflows)
      .values({ id: workflowId, name: 'wf', definition: JSON.stringify(def) })
    await h.db.insert(tasks).values({
      id: taskId,
      name: 't5',
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: h.repoPath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: JSON.stringify({ req: 'build dashboard' }),
      startedAt: Date.now(),
    })

    // ---- ROUND 1: P 问 ----
    const R1 = clarifyBody('r1q', 'ROUND1_PLATFORM_Q', ['R1_ANS_REACT', 'R1_ANS_VUE'])
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: R1 }, () => run(h, taskId))
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
      'awaiting_human',
    )
    const r1sess = (
      await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
    )[0]!
    await sealRoundQuestions({
      db: h.db,
      originNodeRunId: r1sess.clarifyNodeRunId,
      answers: [ans('r1q', 0, 'R1_ANS_REACT')],
      directive: 'continue',
      autoStage: true,
      sealedBy: 'u1',
    })
    await dispatchTaskQuestions(
      h.db,
      taskId,
      [await selfEntryId(h, taskId, r1sess.clarifyNodeRunId)],
      actor,
    )
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // ---- ROUND 2: P 再问(注入 round1) ----
    const R2 = clarifyBody('r2q', 'ROUND2_LANGUAGE_Q', ['R2_ANS_TYPESCRIPT', 'R2_ANS_JS'])
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: R2 }, () => run(h, taskId))
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
      'awaiting_human',
    )
    const r2sess = (
      await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
    ).find((s) => s.iterationIndex === 1)!
    await sealRoundQuestions({
      db: h.db,
      originNodeRunId: r2sess.clarifyNodeRunId,
      answers: [ans('r2q', 0, 'R2_ANS_TYPESCRIPT')],
      directive: 'stop',
      autoStage: true,
      sealedBy: 'u1',
    })
    const d2 = await dispatchTaskQuestions(
      h.db,
      taskId,
      [await selfEntryId(h, taskId, r2sess.clarifyNodeRunId)],
      actor,
    )
    const finalRerunId = d2.reruns[0]!.nodeRunId
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // ---- FINAL: P 产出 doc(STOP 放行 → output) ----
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ doc: 'FINAL_DOC' }) }, () =>
      run(h, taskId),
    )

    const finalRerun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, finalRerunId)))[0]!
    expect(finalRerun.status).toBe('done')
    const prompt = finalRerun.promptText ?? ''
    // round1 答案:旧 window 判据在此丢失(01KWDKBS bug);RFC-131 派生老化保留它。
    expect(prompt).toContain('R1_ANS_REACT')
    expect(prompt).toContain('R2_ANS_TYPESCRIPT')
    // RFC-132 (PR-C):两轮进 SINGLE 平铺 `## Clarify Q&A` 块、对等 peer,无 `### Round N` 分组。
    // 01KWDKBS 仍锁死:两轮答案都在(派生老化在本 rerun 产出前不老化 round1)。
    expect(prompt).toContain('## Clarify Q&A')
    expect(prompt).toContain('ROUND1_PLATFORM_Q')
    expect(prompt).toContain('ROUND2_LANGUAGE_Q')
    expect(prompt).not.toContain('### Round')
  })
})

// RFC-319 B50 —— HUMAN-22：改派问题的处理节点。
//
// 改派是「这题该由谁来答」的唯一调整手段。它的两道守卫防的都是**死锁**，
// 而死锁在这个产品里的表现是「任务安安静静地永远不动」：
//
//   * **目标必须是工作流里的 agent 节点**。改派到 clarify / review / io / wrapper 节点
//     看起来毫无问题——它们都在图上、都有 id——但它们**没有提示词、没有产出契约**，
//     下发到那儿的问题永远不会被回答。守卫若失守，界面上一切正常：改派成功、条目
//     换了个承接人、任务继续等着，等到天荒地老。
//   * **人工提问的目标必须至少跑过一次**。人工提问靠「重跑它的承接节点」来落地
//     （`services/taskQuestions.ts:955-961`）；改派到一个从没跑过的节点，§18 的 park gate
//     会把任务停在一个**下发永远铸不出重跑**的目标上——同样是安静的死锁。
//
// 两条判据都必须补一条：**被拒之后条目原样不变**。先落库再报错同样返回 4xx，
// 而那种实现会把条目留在一个非法承接人上。
//
// 判据取自源码单一事实源：
//   shared/task-questions.ts:184-186        canReassign：目标须在该任务的 agent 节点集合里
//   services/taskQuestions.ts:937-942       非 agent 目标 ⇒ task-question-reassign-invalid
//   services/taskQuestions.ts:955-961       manual 目标未跑过 ⇒ manual-question-target-never-run
//   services/taskQuestionConflicts.ts:27-28 码名

import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let repoDir: string
let stubState: string
let taskId: string
let manualEntryId: string

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function raw(
  path: string,
  payload: unknown,
): Promise<{ status: number; code: string | null }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: res.status, code }
}

interface BoardEntry {
  id: string
  questionId: string
  phase: string
  sourceKind: string
  effectiveTargetNodeId?: string | null
  overrideTargetNodeId?: string | null
}
const board = async (): Promise<BoardEntry[]> => api<BoardEntry[]>(`/api/tasks/${taskId}/questions`)

/** 只比「承接人 + 阶段」——看板行还带 updatedAt 之类的时间戳，整体深比会因无关字段红。 */
const handlersOf = (rows: BoardEntry[]): string[] =>
  rows
    .map(
      (e) => `${e.id}:${e.phase}:${e.overrideTargetNodeId ?? ''}:${e.effectiveTargetNodeId ?? ''}`,
    )
    .sort()

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-reassign-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 reassign fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-reassign-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const designer = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-reassign-designer',
      description: 'RFC-319 reassign fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const spare = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-reassign-spare',
      description: 'RFC-319 reassign fixture (downstream, never runs while parked)',
      outputs: ['refined'],
      outputKinds: { refined: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-reassign-wf',
      description: 'RFC-319 reassign fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: designer.id,
            agentName: 'rfc319-reassign-designer',
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            position: { x: 560, y: 160 },
          },
          {
            // 下游 agent：任务停在澄清门上时它**从没跑过**，正好用来打
            // manual-question-target-never-run 那道守卫。
            id: 'spare',
            kind: 'agent-single',
            agentId: spare.id,
            agentName: 'rfc319-reassign-spare',
            promptTemplate: 'Refine {{design}}.',
            position: { x: 860, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_designer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
          {
            id: 'e_clarify_ask',
            source: { nodeId: 'designer', portName: '__clarify__' },
            target: { nodeId: 'clarify_1', portName: 'questions' },
          },
          {
            id: 'e_clarify_ans',
            source: { nodeId: 'clarify_1', portName: 'answers' },
            target: { nodeId: 'designer', portName: '__clarify_response__' },
          },
          {
            id: 'e_designer_spare',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'spare', portName: 'design' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-reassign-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  await expect
    .poll(
      async () => {
        const rows = await api<Array<{ id: string }>>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        return rows.length
      },
      { timeout: 180_000 },
    )
    .toBeGreaterThan(0)

  const created = await api<{ id: string }>(`/api/tasks/${taskId}/questions/manual`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'rfc319-b50-manual',
      body: 'rfc319-b50-please-also-note-the-migration',
      targetNodeId: 'designer',
    }),
  })
  manualEntryId = created.id
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('改派到非 agent 节点必须被拒 —— 那种目标永远不会回答，任务会安静地卡死 @nightly', async () => {
  const before = await board()
  // clarify / input 节点都在图上、都有 id，看起来是完全合法的目标；它们没有的是
  // 提示词与产出契约。守卫失守时界面上一切正常，只是任务再也不会动。
  for (const target of ['clarify_1', 'in_1']) {
    const res = await raw(`/api/tasks/${taskId}/questions/${manualEntryId}/reassign`, {
      targetNodeId: target,
    })
    expect(res.status, `改派到 ${target} 必须被拒`).toBe(422)
    expect(res.code).toBe('task-question-reassign-invalid')
  }
  // 图上根本不存在的 id 同样走这条守卫。
  const ghost = await raw(`/api/tasks/${taskId}/questions/${manualEntryId}/reassign`, {
    targetNodeId: 'no_such_node',
  })
  expect(ghost.status).toBe(422)
  expect(ghost.code).toBe('task-question-reassign-invalid')

  // 被拒之后条目**原样不变**：先落库再报错同样返回 4xx，而那种实现会把条目
  // 留在一个非法承接人上。
  expect(handlersOf(await board()), '被拒的改派不该改动任何承接人').toEqual(handlersOf(before))
})

test('人工提问改派到「从没跑过」的节点也要被拒 —— 下发永远铸不出重跑 @nightly', async () => {
  const before = await board()
  // `spare` 是图上货真价实的 agent 节点（canReassign 放行），但任务停在澄清门上时
  // 它一次都没跑过。人工提问靠「重跑承接节点」落地，改派过去等于把任务停在一个
  // 下发永远铸不出重跑的目标上。
  const res = await raw(`/api/tasks/${taskId}/questions/${manualEntryId}/reassign`, {
    targetNodeId: 'spare',
  })
  expect(res.status, 'agent 节点但从没跑过 ⇒ 仍要拒').toBe(422)
  expect(res.code).toBe('manual-question-target-never-run')
  expect(handlersOf(await board()), '被拒的改派不该改动任何承接人').toEqual(handlersOf(before))
})

test('正向对照：改派到跑过的 agent 节点是允许的 @nightly', async () => {
  // 少了这一条，「改派对任何目标都拒」也能让上面两条成立——而那等于功能不存在。
  const res = await raw(`/api/tasks/${taskId}/questions/${manualEntryId}/reassign`, {
    targetNodeId: 'designer',
  })
  expect(res.status, `合法改派应当通过：${res.code}`).toBe(200)
  const row = (await board()).find((e) => e.id === manualEntryId)
  expect(row, '条目还在').toBeDefined()
  expect(row!.phase, '改派不改变阶段').toBe('staged')
})

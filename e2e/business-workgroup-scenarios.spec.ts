// Real-business Workgroup scenarios against the public API and compiled daemon.
//
// The scenario exercises durable free-collab planning, batch task settlement,
// per-card failure reopening, real isolated worktrees, merge-back, room
// projection and the human completion gate. Only the external model process is
// replaced by a deterministic, network-free fixture.

import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUSINESS_OPERATIONS_TASK,
  seedBusinessOperationsScenario,
  type BusinessOperationsSeedResult,
} from '../examples/workgroups/scenarios/business-operations'
import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUSINESS_STUB = join(HERE, 'fixtures', 'stub-opencode-business-workgroups.ts')

interface TaskRow {
  id: string
  status: string
  errorMessage?: string | null
}

interface AgentMutationDetail {
  id: string
  updatedAt: number
  aclRevision: number
  runtime?: string
}

interface WorkgroupMutationDetail {
  id: string
  name: string
  description: string
  instructions: string
  mode: 'leader_worker' | 'free_collab' | 'dynamic_workflow'
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  maxRounds: number
  completionGate: boolean
  clarifyBudget?: number
  fanOut?: boolean
  version: number
  members: Array<{
    memberType: 'agent' | 'human'
    agentId?: string | null
    userId: string | null
    displayName: string
    roleDesc: string
    sortOrder: number
  }>
}

interface NodeRunRow {
  id: string
  status: string
  shardKey: string | null
  rerunCause: string | null
  promptText: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
}

interface RoomRow {
  taskStatus: string
  gate: {
    awaitingConfirmation: boolean
    summary: string | null
  }
  messages: Array<{
    id: string
    kind: string
    bodyMd: string
    authorMemberId: string | null
    assignmentId: string | null
  }>
  assignments: Array<{
    id: string
    title: string
    status: string
    assigneeMemberId: string | null
    resultMessageId: string | null
  }>
  runHistory: Array<{
    nodeRunId: string
    displayName: string
    kind: string
    status: string
  }>
}

interface WorktreeFile {
  path: string
  content: string
  oversized: boolean
}

let daemon: DaemonHandle
let stateDir: string
let seeded: BusinessOperationsSeedResult

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-business-workgroup-state-'))
  daemon = await startDaemon({
    stubOpencode: BUSINESS_STUB,
    extraEnv: { BUSINESS_WORKGROUP_STATE_DIR: stateDir },
    configOverrides: {
      defaultNodeRetries: 1,
      defaultPerNodeTimeoutMs: 10_000,
      maxConcurrentNodes: 6,
    },
  })
  seeded = await seedBusinessOperationsScenario({
    baseUrl: daemon.baseUrl,
    token: daemon.token,
    launch: true,
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function expectHttp(response: Response, expected: number, what: string): Promise<void> {
  if (response.status === expected) return
  throw new Error(
    `${what}: expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
  )
}

async function waitForRoom(
  taskId: string,
  predicate: (room: RoomRow) => boolean,
  timeoutMs = 60_000,
): Promise<RoomRow> {
  const deadline = Date.now() + timeoutMs
  let last: RoomRow | null = null
  while (Date.now() < deadline) {
    const response = await apiFetch(`/api/workgroup-tasks/${taskId}/room`)
    if (response.ok) {
      last = (await response.json()) as RoomRow
      if (predicate(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`room ${taskId} did not reach expected state; last=${JSON.stringify(last)}`)
}

async function waitForTask(
  taskId: string,
  predicate: (task: TaskRow) => boolean,
  timeoutMs = 30_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow = { id: taskId, status: 'pending' }
  while (Date.now() < deadline) {
    const response = await apiFetch(`/api/tasks/${taskId}`)
    if (response.ok) {
      last = (await response.json()) as TaskRow
      if (predicate(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`task ${taskId} did not reach expected state; last=${JSON.stringify(last)}`)
}

async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
  const response = await apiFetch(`/api/tasks/${taskId}/node-runs`)
  await expectHttp(response, 200, `read node runs ${taskId}`)
  return (await response.json()) as NodeRunsResponse
}

async function listTasks(): Promise<TaskRow[]> {
  const response = await apiFetch('/api/tasks?scope=mine&limit=500')
  await expectHttp(response, 200, 'list tasks')
  return (await response.json()) as TaskRow[]
}

async function readWorktree(taskId: string, path: string): Promise<WorktreeFile> {
  const response = await apiFetch(
    `/api/tasks/${taskId}/worktree-file?path=${encodeURIComponent(path)}`,
  )
  await expectHttp(response, 200, `read ${path} from ${taskId}`)
  return (await response.json()) as WorktreeFile
}

function batchTaskTitles(prompt: string): string[] {
  return [...prompt.matchAll(/^### Task \d+: (.+)$/gm)].map((match) => match[1] ?? '')
}

function batchAssignmentIds(shardKey: string | null): string[] {
  if (shardKey === null || !shardKey.startsWith('batch:')) return []
  const memberSeparator = shardKey.indexOf(':', 'batch:'.length)
  if (memberSeparator < 0) return []
  return shardKey
    .slice(memberSeparator + 1)
    .split('+')
    .filter((id) => id.length > 0)
}

function persistedAssignmentAttempts(taskId: string): Map<string, number> {
  const safeTaskId = taskId.replaceAll("'", "''")
  const outputPath = join(
    stateDir,
    `assignment-attempts-${Date.now()}-${Math.random().toString(36).slice(2)}.tsv`,
  )
  const safeOutputPath = outputPath.replaceAll("'", "''")
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    `SELECT writefile(
       '${safeOutputPath}',
       CAST(COALESCE((
         SELECT group_concat(id || char(9) || attempt_count, char(10))
         FROM (
           SELECT id, attempt_count
           FROM workgroup_assignments
           WHERE task_id='${safeTaskId}'
           ORDER BY id
         )
       ), '') AS BLOB)
     );`,
  )
  try {
    return new Map(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [id, rawCount] = line.split('\t')
          if (id === undefined || rawCount === undefined) {
            throw new Error(`unexpected workgroup assignment row: ${line}`)
          }
          return [id, Number(rawCount)] as const
        }),
    )
  } finally {
    rmSync(outputPath, { force: true })
  }
}

test('业务场景 seed：只复用契约完全一致的 Agent 与 Workgroup', async () => {
  const reused = await seedBusinessOperationsScenario({
    baseUrl: daemon.baseUrl,
    token: daemon.token,
  })
  expect(reused.agents.migrationPlanner.id).toBe(seeded.agents.migrationPlanner.id)
  expect(reused.agents.migrationRiskReviewer.id).toBe(seeded.agents.migrationRiskReviewer.id)
  expect(reused.workgroup.id).toBe(seeded.workgroup.id)
  expect(reused.task).toBeUndefined()
})

test('客户数据迁移作战室：单卡失败只重开该卡，保留成功实物并经人工门收敛', async () => {
  const task = seeded.task
  if (task === undefined) throw new Error('business scenario seed did not launch its task')

  const gated = await waitForRoom(
    task.id,
    (room) => room.taskStatus === 'awaiting_review' && room.gate.awaitingConfirmation,
  )

  if (gated.assignments.length === 0) {
    const diagnosticRuns = await nodeRuns(task.id)
    const diagnosticTrace = readFileSync(join(stateDir, 'prompts.jsonl'), 'utf-8')
    throw new Error(
      `migration scenario converged without cards: ${JSON.stringify({
        room: gated,
        runs: diagnosticRuns.runs,
        trace: diagnosticTrace,
      })}`,
    )
  }

  expect(gated.assignments.map((assignment) => assignment.title).sort()).toEqual(
    ['Freeze source schema', 'Validate encrypted export', 'Prepare rollback runbook'].sort(),
  )
  expect(gated.assignments.every((assignment) => assignment.status === 'done')).toBe(true)
  expect(gated.assignments.every((assignment) => assignment.resultMessageId !== null)).toBe(true)
  expect(gated.gate.summary).toBe('free-collab converged')
  expect(
    gated.messages.some((message) =>
      message.bodyMd.includes(
        'Migration controls decomposed into three independently auditable cards.',
      ),
    ),
  ).toBe(true)
  expect(
    gated.messages.some((message) =>
      message.bodyMd.includes(
        'Risk reviewer confirmed the plan separates schema, export-integrity, and rollback controls.',
      ),
    ),
  ).toBe(true)

  const assignmentByTitle = new Map(
    gated.assignments.map((assignment) => [assignment.title, assignment]),
  )
  const schemaAssignment = assignmentByTitle.get('Freeze source schema')
  const exportAssignment = assignmentByTitle.get('Validate encrypted export')
  const rollbackAssignment = assignmentByTitle.get('Prepare rollback runbook')
  if (
    schemaAssignment === undefined ||
    exportAssignment === undefined ||
    rollbackAssignment === undefined
  ) {
    throw new Error('migration scenario is missing one or more expected assignments')
  }
  const failureMessage = gated.messages.find(
    (message) =>
      message.kind === 'system' &&
      message.bodyMd.includes("assignment 'Validate encrypted export' reported failed") &&
      message.bodyMd.includes('checksum mismatched'),
  )
  expect(failureMessage?.assignmentId).toBe(exportAssignment.id)
  expect(gated.messages.some((message) => message.bodyMd.includes('MIGRATION_RETRY:'))).toBe(true)
  expect(gated.messages.some((message) => message.bodyMd.includes('MIGRATION_RECOVERED:'))).toBe(
    true,
  )
  expect(
    gated.messages.some(
      (message) =>
        message.kind === 'decision' &&
        message.bodyMd.includes('free-collab converged') &&
        message.bodyMd.includes('Encrypted export checksum and record count verified on retry.'),
    ),
  ).toBe(true)

  const data = await nodeRuns(task.id)
  const roomRunIds = new Set(gated.runHistory.map((run) => run.nodeRunId))
  const batchRuns = data.runs.filter(
    (run) => run.promptText?.includes('## Your assignments (batch of') === true,
  )
  expect(batchRuns.every((run) => roomRunIds.has(run.id))).toBe(true)
  const titleCounts = new Map<string, number>()
  const assignmentAttemptCounts = new Map<string, number>()
  for (const run of batchRuns) {
    for (const title of batchTaskTitles(run.promptText ?? '')) {
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
    }
    for (const assignmentId of batchAssignmentIds(run.shardKey)) {
      assignmentAttemptCounts.set(
        assignmentId,
        (assignmentAttemptCounts.get(assignmentId) ?? 0) + 1,
      )
    }
  }

  expect(batchRuns).toHaveLength(2)
  expect(titleCounts.get('Freeze source schema')).toBe(1)
  expect(titleCounts.get('Prepare rollback runbook')).toBe(1)
  expect(titleCounts.get('Validate encrypted export')).toBe(2)
  expect(assignmentAttemptCounts.get(schemaAssignment.id)).toBe(1)
  expect(assignmentAttemptCounts.get(rollbackAssignment.id)).toBe(1)
  expect(assignmentAttemptCounts.get(exportAssignment.id)).toBe(2)
  const persistedAttempts = persistedAssignmentAttempts(task.id)
  expect(persistedAttempts).toEqual(
    new Map([
      [schemaAssignment.id, 1],
      [exportAssignment.id, 2],
      [rollbackAssignment.id, 1],
    ]),
  )
  expect(
    batchRuns.some((run) => {
      const titles = batchTaskTitles(run.promptText ?? '')
      return (
        titles.length === 3 &&
        titles.includes('Freeze source schema') &&
        titles.includes('Validate encrypted export') &&
        titles.includes('Prepare rollback runbook')
      )
    }),
  ).toBe(true)
  expect(
    batchRuns.some((run) => {
      const titles = batchTaskTitles(run.promptText ?? '')
      return titles.length === 1 && titles[0] === 'Validate encrypted export'
    }),
  ).toBe(true)
  expect(data.runs.filter((run) => run.status === 'failed')).toEqual([])
  const expectedResultSummary = new Map([
    ['Freeze source schema', 'Source schema frozen and field mapping recorded.'],
    ['Validate encrypted export', 'Encrypted export checksum and record count verified on retry.'],
    ['Prepare rollback runbook', 'Rollback abort criteria and restore steps recorded.'],
  ])
  for (const assignment of gated.assignments) {
    const expectedSummary = expectedResultSummary.get(assignment.title)
    if (expectedSummary === undefined) {
      throw new Error(`missing expected result summary for ${assignment.title}`)
    }
    const resultMessage = gated.messages.find(
      (message) => message.id === assignment.resultMessageId,
    )
    expect(resultMessage?.assignmentId).toBe(assignment.id)
    expect(resultMessage?.kind).toBe('result')
    expect(resultMessage?.authorMemberId).toBe(assignment.assigneeMemberId)
    expect(resultMessage?.bodyMd).toContain(expectedSummary)
  }

  expect((await readWorktree(task.id, 'migration/schema-map.md')).content).toContain(
    'email -> encrypted_email',
  )
  const exportValidation = (await readWorktree(task.id, 'migration/export-validation.txt')).content
  expect(exportValidation).toContain('checksum=verified')
  expect(exportValidation).toContain('records=125000')
  expect((await readWorktree(task.id, 'migration/rollback-runbook.md')).content).toContain(
    'Restore the pre-cutover snapshot',
  )

  const trace = readFileSync(join(stateDir, 'prompts.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { agent: string; cwd: string; prompt: string })
  expect(new Set(trace.map((entry) => entry.agent))).toEqual(
    new Set(['business-migration-planner', 'business-migration-risk-reviewer']),
  )
  expect(trace.every((entry) => entry.prompt.includes(BUSINESS_OPERATIONS_TASK.goal))).toBe(true)
  expect(
    new Set(
      trace
        .filter((entry) => entry.prompt.includes('## Your assignments (batch of'))
        .map((entry) => entry.agent),
    ),
  ).toEqual(new Set(['business-migration-planner']))
  const planningTrace = trace.filter((entry) => entry.prompt.includes('## Initial planning turn'))
  expect(new Set(planningTrace.map((entry) => entry.agent))).toEqual(
    new Set(['business-migration-planner', 'business-migration-risk-reviewer']),
  )
  expect(new Set(planningTrace.map((entry) => entry.cwd)).size).toBe(2)

  const approve = await apiFetch(`/api/workgroup-tasks/${task.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve' }),
  })
  await expectHttp(approve, 200, 'approve migration completion gate')
  const final = await waitForTask(task.id, (row) => row.status === 'done')
  expect(final.status).toBe('done')
})

test('业务场景 seed：Agent 执行契约或 Workgroup 调度契约漂移时拒绝启动', async () => {
  const taskCount = (await listTasks()).length
  const plannerId = seeded.agents.migrationPlanner.id

  const plannerResponse = await apiFetch(`/api/agents/${plannerId}`)
  await expectHttp(plannerResponse, 200, 'load planner before contract drift')
  const planner = (await plannerResponse.json()) as AgentMutationDetail
  const pinRuntime = await apiFetch(`/api/agents/${plannerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      runtime: 'opencode',
      expectedUpdatedAt: planner.updatedAt,
      expectedAclRevision: planner.aclRevision,
    }),
  })
  await expectHttp(pinRuntime, 200, 'pin planner runtime to create contract drift')

  try {
    await expect(
      seedBusinessOperationsScenario({
        baseUrl: daemon.baseUrl,
        token: daemon.token,
        launch: true,
      }),
    ).rejects.toThrow(/Agent business-migration-planner.+contract has drifted/)
  } finally {
    const driftedResponse = await apiFetch(`/api/agents/${plannerId}`)
    await expectHttp(driftedResponse, 200, 'load drifted planner for restore')
    const drifted = (await driftedResponse.json()) as AgentMutationDetail
    const restoreRuntime = await apiFetch(`/api/agents/${plannerId}`, {
      method: 'PUT',
      body: JSON.stringify({
        runtime: null,
        expectedUpdatedAt: drifted.updatedAt,
        expectedAclRevision: drifted.aclRevision,
      }),
    })
    await expectHttp(restoreRuntime, 200, 'restore planner runtime')
  }
  expect(await listTasks()).toHaveLength(taskCount)

  const workgroupResponse = await apiFetch(`/api/workgroups/${seeded.workgroup.id}`)
  await expectHttp(workgroupResponse, 200, 'load workgroup before contract drift')
  const workgroup = (await workgroupResponse.json()) as WorkgroupMutationDetail
  const members = [...workgroup.members]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    )
  const driftWorkgroup = await apiFetch(`/api/workgroups/${workgroup.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: workgroup.version,
      clientMutationId: '01K00000000000000000000001',
      snapshot: {
        name: workgroup.name,
        description: workgroup.description,
        instructions: workgroup.instructions,
        mode: workgroup.mode,
        switches: workgroup.switches,
        maxRounds: workgroup.maxRounds + 1,
        completionGate: workgroup.completionGate,
        clarifyBudget: workgroup.clarifyBudget ?? 3,
        fanOut: workgroup.fanOut ?? false,
        members,
      },
    }),
  })
  await expectHttp(driftWorkgroup, 200, 'change workgroup retry budget to create contract drift')

  await expect(
    seedBusinessOperationsScenario({
      baseUrl: daemon.baseUrl,
      token: daemon.token,
      launch: true,
    }),
  ).rejects.toThrow(/Workgroup business-customer-data-migration-war-room.+contract has drifted/)
  expect(await listTasks()).toHaveLength(taskCount)
})

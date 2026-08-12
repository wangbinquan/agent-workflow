// End-to-end workgroup capability matrix.
//
// These cases use the public HTTP API and a real compiled daemon. They exercise
// the durable scheduler, real Bun subprocesses, isolated Git worktrees,
// merge-back, workgroup prompt/protocol projection and human gates. The only
// replacement is the external model process, which is deterministic and
// network-free while speaking each runtime's production wire protocol
// (fixtures/stub/mode-workgroup-matrix.ts).

import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  seedShowcase,
  SHOWCASE_TASKS,
  type ShowcaseAgentKey,
  type ShowcaseSeedResult,
  type ShowcaseWorkgroupKey,
} from '../examples/workgroups/showcase/seed'
import { startDaemon, type DaemonHandle } from './harness'

interface TaskRow {
  id: string
  status: string
  errorMessage?: string | null
}

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  shardKey: string | null
  rerunCause: string | null
  promptText: string | null
  startedAt: number | null
  finishedAt: number | null
  errorMessage: string | null
  failureCode?: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

interface ClarifyRow {
  taskId: string
  askingNodeId: string
  intermediaryNodeRunId: string
  iteration: number
  questionCount: number
}

interface RoomRow {
  taskId: string
  taskStatus: string
  config: {
    mode: string
    switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  }
  gate: {
    declaredDone: boolean
    awaitingConfirmation: boolean
    rejected: boolean
    summary: string | null
  }
  dw: null | {
    phase: string
    rejectRounds: number
    rejectionComment?: string
    generatedDef?: {
      nodes?: Array<{ id?: string }>
    }
  }
  messages: Array<{ kind: string; bodyMd: string }>
  assignments: Array<{
    id: string
    assigneeMemberId: string | null
    title: string
    status: string
  }>
  runHistory: Array<{
    nodeRunId: string
    memberId: string | null
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

type Protocol = 'opencode' | 'claude-code'

test.setTimeout(180_000)

for (const protocol of ['opencode', 'claude-code'] as const satisfies readonly Protocol[]) {
  test.describe(`workgroup capability matrix: ${protocol}`, () => {
    let daemon: DaemonHandle
    let stateDir: string
    let adminUserId: string
    let showcase: ShowcaseSeedResult

    test.beforeAll(async () => {
      stateDir = mkdtempSync(join(tmpdir(), `aw-workgroup-matrix-${protocol}-state-`))
      daemon = await startDaemon({
        stubMode: 'workgroup-matrix',
        extraEnv: { WORKGROUP_MATRIX_STATE_DIR: stateDir },
        configOverrides: {
          defaultRuntime: protocol,
          defaultNodeRetries: 1,
          defaultPerNodeTimeoutMs: 10_000,
          maxConcurrentNodes: 6,
          multiProcessSubprocessConcurrency: 6,
        },
      })

      showcase = await seedShowcase({
        baseUrl: daemon.baseUrl,
        token: daemon.token,
        runtime: protocol,
      })
      adminUserId = showcase.userId
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

    function agentId(key: ShowcaseAgentKey): string {
      return showcase.agents[key].id
    }

    async function launchWorkgroup(key: ShowcaseWorkgroupKey): Promise<TaskRow> {
      const group = showcase.workgroups[key]
      const task = SHOWCASE_TASKS[key]
      const response = await apiFetch(`/api/workgroups/${group.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          name: task.name,
          goal: task.goal,
          scratch: true,
          expectedWorkgroupId: group.id,
          expectedWorkgroupVersion: group.version,
        }),
      })
      await expectHttp(response, 201, `launch workgroup ${group.name}`)
      return (await response.json()) as TaskRow
    }

    async function waitForTask(
      taskId: string,
      predicate: (task: TaskRow) => boolean,
      timeoutMs = 45_000,
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

    async function room(taskId: string): Promise<RoomRow> {
      const response = await apiFetch(`/api/workgroup-tasks/${taskId}/room`)
      await expectHttp(response, 200, `read room ${taskId}`)
      return (await response.json()) as RoomRow
    }

    async function waitForRoom(
      taskId: string,
      predicate: (value: RoomRow) => boolean,
      timeoutMs = 45_000,
    ): Promise<RoomRow> {
      const deadline = Date.now() + timeoutMs
      let last: RoomRow | null = null
      while (Date.now() < deadline) {
        last = await room(taskId)
        if (predicate(last)) return last
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`room ${taskId} did not reach expected state; last=${JSON.stringify(last)}`)
    }

    async function nodeRuns(taskId: string): Promise<NodeRunsResponse> {
      const response = await apiFetch(`/api/tasks/${taskId}/node-runs`)
      await expectHttp(response, 200, `read node runs ${taskId}`)
      return (await response.json()) as NodeRunsResponse
    }

    async function waitForClarify(taskId: string): Promise<ClarifyRow> {
      const deadline = Date.now() + 20_000
      let last: ClarifyRow[] = []
      while (Date.now() < deadline) {
        const response = await apiFetch(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        if (response.ok) {
          last = (await response.json()) as ClarifyRow[]
          const match = last.find((candidate) => candidate.askingNodeId === '__wg_leader__')
          if (match !== undefined) return match
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`no leader clarify for ${taskId}; last=${JSON.stringify(last)}`)
    }

    async function readWorktree(taskId: string, path: string): Promise<WorktreeFile> {
      const response = await apiFetch(
        `/api/tasks/${taskId}/worktree-file?path=${encodeURIComponent(path)}`,
      )
      await expectHttp(response, 200, `read ${path} from ${taskId}`)
      return (await response.json()) as WorktreeFile
    }

    function runsForRoomMember(
      data: NodeRunsResponse,
      roomValue: RoomRow,
      displayName: string,
    ): NodeRunRow[] {
      const memberRunIds = new Set(
        roomValue.runHistory
          .filter((run) => run.displayName === displayName)
          .map((run) => run.nodeRunId),
      )
      return data.runs.filter((run) => memberRunIds.has(run.id))
    }

    function assertNoPromptIdentityLeak(data: NodeRunsResponse): void {
      for (const run of data.runs) {
        if (run.promptText !== null) expect(run.promptText).not.toContain(adminUserId)
      }
    }

    test('leader-worker: clarify → same-member fan-out → protocol retry → gate reject/revise/approve', async () => {
      const task = await launchWorkgroup('leaderWorker')

      const parked = await waitForTask(
        task.id,
        (row) => row.status === 'awaiting_human' || row.status === 'failed',
      )
      if (parked.status !== 'awaiting_human') {
        const failedRuns = await nodeRuns(task.id)
        throw new Error(
          `leader-worker failed before clarification: ${JSON.stringify({
            task: parked,
            runs: failedRuns.runs.map((run) => ({
              nodeId: run.nodeId,
              status: run.status,
              retryIndex: run.retryIndex,
              rerunCause: run.rerunCause,
              errorMessage: run.errorMessage,
              failureCode: run.failureCode,
              promptText: run.promptText,
            })),
          })}`,
        )
      }
      const clarification = await waitForClarify(task.id)
      expect(clarification.questionCount).toBe(1)
      const answer = await apiFetch(`/api/clarify/${clarification.intermediaryNodeRunId}/answers`, {
        method: 'POST',
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-release-strategy',
              selectedOptionIndices: [0],
              selectedOptionLabels: ['blue-green'],
              customText: '',
            },
          ],
          directive: 'stop',
          ifMatchIteration: clarification.iteration,
        }),
      })
      await expectHttp(answer, 200, 'answer leader clarify')

      const firstGate = await waitForRoom(
        task.id,
        (value) => value.taskStatus === 'awaiting_review' && value.gate.awaitingConfirmation,
      )
      expect(firstGate.assignments.map((assignment) => assignment.title).sort()).toEqual([
        'implementation-v1-code',
        'implementation-v1-tests',
        'research-release',
      ])
      expect(firstGate.assignments.every((assignment) => assignment.status === 'done')).toBe(true)

      const reject = await apiFetch(`/api/workgroup-tasks/${task.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'reject',
          comment: 'REVISE_AFTER_GATE_REJECTION',
        }),
      })
      await expectHttp(reject, 200, 'reject first completion gate')

      const secondGate = await waitForRoom(
        task.id,
        (value) =>
          value.taskStatus === 'awaiting_review' &&
          value.gate.awaitingConfirmation &&
          value.assignments.some(
            (assignment) =>
              assignment.title === 'implementation-v2' && assignment.status === 'done',
          ),
      )
      expect(secondGate.assignments).toHaveLength(4)

      const beforeApproval = await nodeRuns(task.id)
      assertNoPromptIdentityLeak(beforeApproval)
      const leaderRuns = runsForRoomMember(beforeApproval, secondGate, 'lead')
      expect(leaderRuns).toHaveLength(5)
      expect(leaderRuns[0]?.promptText).toContain('WG_MATRIX_GOAL literal {{do_not_expand}}')
      expect(
        leaderRuns.some(
          (run) =>
            run.promptText?.includes('## Completion gate REJECTED') === true &&
            run.promptText.includes('REVISE_AFTER_GATE_REJECTION'),
        ),
      ).toBe(true)

      const builderRuns = runsForRoomMember(beforeApproval, secondGate, 'builder')
      const codeRuns = builderRuns.filter((run) =>
        run.promptText?.includes('Title: implementation-v1-code'),
      )
      expect(codeRuns).toHaveLength(2)
      expect(codeRuns.map((run) => run.retryIndex)).toEqual([0, 1])
      expect(codeRuns[1]?.rerunCause).toBe('wg-protocol-retry')
      expect(codeRuns[1]?.promptText).toContain('## Protocol errors in your previous reply')
      expect(codeRuns[1]?.promptText).toContain('wg_result')
      expect(
        builderRuns.filter((run) => run.promptText?.includes('Title: implementation-v1-tests')),
      ).toHaveLength(1)
      expect(
        builderRuns.some(
          (run) =>
            run.promptText?.includes('PRIVATE_BUILD_CONSTRAINT') === true &&
            run.promptText.includes('PUBLIC_RELEASE_CONSTRAINT'),
        ),
      ).toBe(true)
      expect(builderRuns.every((run) => !run.promptText?.includes('WG_MATRIX_GOAL'))).toBe(true)
      expect(
        beforeApproval.runs.filter(
          (run) => run.status === 'failed' || run.status === 'interrupted',
        ),
      ).toEqual([])

      expect((await readWorktree(task.id, 'showcase/app.txt')).content).toBe(
        'implementation v2 after gate rejection\n',
      )
      expect((await readWorktree(task.id, 'showcase/tests.txt')).content).toBe(
        'independent tests v1\n',
      )

      const approve = await apiFetch(`/api/workgroup-tasks/${task.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      })
      await expectHttp(approve, 200, 'approve revised completion gate')
      const final = await waitForTask(task.id, (row) => row.status === 'done')
      expect(final.status).toBe('done')
    })

    test('free-collab: parallel planning, normalized dedup, dual message/task tracks, batch merge and gate', async () => {
      const task = await launchWorkgroup('freeCollab')

      const gated = await waitForRoom(
        task.id,
        (value) => value.taskStatus === 'awaiting_review' && value.gate.awaitingConfirmation,
      )
      expect(gated.config.switches).toEqual({
        shareOutputs: false,
        directMessages: false,
        blackboard: false,
      })
      expect(gated.assignments).toHaveLength(3)
      expect(gated.assignments.every((assignment) => assignment.status === 'done')).toBe(true)
      expect(
        gated.messages.some(
          (message) => message.kind === 'system' && message.bodyMd.includes('duplicate'),
        ),
      ).toBe(true)
      expect(gated.messages.some((message) => message.bodyMd.includes('FC_PRIVATE_SIGNAL'))).toBe(
        true,
      )
      expect(gated.messages.some((message) => message.bodyMd.includes('FC_PUBLIC_SIGNAL'))).toBe(
        true,
      )

      const data = await nodeRuns(task.id)
      assertNoPromptIdentityLeak(data)
      const alphaRuns = runsForRoomMember(data, gated, 'alpha')
      const betaRuns = runsForRoomMember(data, gated, 'beta')
      expect(alphaRuns.some((run) => run.promptText?.includes('## Initial planning turn'))).toBe(
        true,
      )
      expect(betaRuns.some((run) => run.promptText?.includes('## Initial planning turn'))).toBe(
        true,
      )
      expect(
        [...alphaRuns, ...betaRuns].every(
          (run) => run.promptText?.includes('FC_MATRIX_GOAL literal {{fc_literal}}') === true,
        ),
      ).toBe(true)
      expect(
        betaRuns.some(
          (run) =>
            run.promptText?.includes('## Message turn') === true &&
            run.promptText.includes('FC_PRIVATE_SIGNAL') &&
            run.promptText.includes('FC_PUBLIC_SIGNAL'),
        ),
      ).toBe(true)
      const batchRuns = [...alphaRuns, ...betaRuns].filter((run) =>
        run.promptText?.includes('## Your assignments (batch of'),
      )
      expect(batchRuns.length).toBeGreaterThanOrEqual(1)
      expect(batchRuns.every((run) => run.promptText?.includes('FC_PUBLIC_SIGNAL') === true)).toBe(
        true,
      )
      expect(data.runs.filter((run) => run.status === 'failed')).toEqual([])

      const alphaFile = await readWorktree(task.id, 'showcase/free-collab-alpha.txt')
      const betaFile = await readWorktree(task.id, 'showcase/free-collab-beta.txt')
      expect(alphaFile.content).toContain('completed')
      expect(betaFile.content).toContain('completed')

      const approve = await apiFetch(`/api/workgroup-tasks/${task.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      })
      await expectHttp(approve, 200, 'approve free-collab gate')
      const final = await waitForTask(task.id, (row) => row.status === 'done')
      expect(final.status).toBe('done')
    })

    test('dynamic-workflow: reject generated graph, regenerate a two-agent DAG, then preserve literal downstream input', async () => {
      const task = await launchWorkgroup('dynamicWorkflow')

      const first = await waitForRoom(
        task.id,
        (value) =>
          value.taskStatus === 'awaiting_review' &&
          value.dw?.phase === 'awaiting_confirm' &&
          value.dw.rejectRounds === 0,
      )
      expect(first.dw?.generatedDef?.nodes?.map((node) => node.id)).toEqual(['dw_initial'])

      const reject = await apiFetch(`/api/workgroup-tasks/${task.id}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'reject',
          comment: 'REGENERATE_WITH_REVIEWER',
        }),
      })
      await expectHttp(reject, 200, 'reject first generated workflow')

      const regenerated = await waitForRoom(
        task.id,
        (value) =>
          value.taskStatus === 'awaiting_review' &&
          value.dw?.phase === 'awaiting_confirm' &&
          value.dw.rejectRounds === 1 &&
          value.dw.generatedDef?.nodes?.some((node) => node.id === 'dw_review') === true,
      )
      expect(regenerated.dw?.generatedDef?.nodes?.map((node) => node.id)).toEqual([
        'dw_source',
        'dw_review',
      ])

      const generatedRuns = await nodeRuns(task.id)
      const orchestratorRuns = generatedRuns.runs.filter(
        (run) => run.nodeId === '__dw_orchestrator__' && run.rerunCause === 'dw-generate',
      )
      expect(orchestratorRuns).toHaveLength(2)
      expect(orchestratorRuns[0]?.promptText).toContain(
        'DW_MATRIX_GOAL literal {{dw_goal_literal}}',
      )
      expect(orchestratorRuns[1]?.promptText).toContain('## Previous attempt was REJECTED')
      expect(orchestratorRuns[1]?.promptText).toContain('REGENERATE_WITH_REVIEWER')
      expect(orchestratorRuns.every((run) => !run.promptText?.includes(adminUserId))).toBe(true)
      expect(
        orchestratorRuns.every(
          (run) =>
            !run.promptText?.includes(agentId('dynamicSource')) &&
            !run.promptText?.includes(agentId('dynamicReviewer')),
        ),
      ).toBe(true)

      const approve = await apiFetch(`/api/workgroup-tasks/${task.id}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      })
      await expectHttp(approve, 200, 'approve regenerated workflow')
      const final = await waitForTask(
        task.id,
        (row) => row.status === 'done' || row.status === 'failed',
      )
      if (final.status !== 'done') {
        const failedRuns = await nodeRuns(task.id)
        throw new Error(
          `dynamic workflow failed: ${JSON.stringify({
            task: final,
            runs: failedRuns.runs.map((run) => ({
              nodeId: run.nodeId,
              status: run.status,
              retryIndex: run.retryIndex,
              errorMessage: run.errorMessage,
              promptText: run.promptText,
            })),
          })}`,
        )
      }

      const data = await nodeRuns(task.id)
      assertNoPromptIdentityLeak(data)
      const source = data.runs.find((run) => run.nodeId === 'dw_source')
      const reviewer = data.runs.find((run) => run.nodeId === 'dw_review')
      expect(source?.status).toBe('done')
      expect(reviewer?.status).toBe('done')
      expect(source?.promptText).toContain('DW_LITERAL_SOURCE')
      expect(reviewer?.promptText).toContain('draft-v2 literal {{must_stay_literal}}')
      expect(
        reviewer?.promptText?.match(/draft-v2 literal \{\{must_stay_literal\}\}/g),
      ).toHaveLength(1)
      expect(
        data.outputs.find((output) => output.nodeRunId === reviewer?.id && output.port === 'report')
          ?.value,
      ).toBe('dynamic reviewer complete')
      expect((await readWorktree(task.id, 'showcase/dynamic-source.txt')).content).toBe(
        'dynamic source produced\n',
      )
      expect((await readWorktree(task.id, 'showcase/dynamic-review.txt')).content).toBe(
        'dynamic review passed\n',
      )

      // Keep a direct artifact-level proof that this matrix never contacted an
      // external model: every invocation belongs to one of the deterministic
      // fixture agents above and was captured in the isolated state directory.
      const trace = readFileSync(join(stateDir, 'prompts.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { agent: string })
      expect(trace.some((entry) => entry.agent === 'aw-workflow-orchestrator')).toBe(true)
      expect(trace.some((entry) => entry.agent === 'showcase-dw-reviewer')).toBe(true)
    })
  })
}

// RFC-294 pre-refactor compatibility oracle — human gates must survive daemon
// replacement without changing task/gate identity or losing continuation.
//
// This deliberately crosses the real production seams that W2/W3 will move:
// public HTTP -> task scheduler -> runtime protocol -> collaboration storage ->
// daemon boot recovery -> continuation dispatch.  Unit tests already cover the
// individual review/clarify state machines; this test protects the user journey
// that is easiest to lose while those pieces move into bounded contexts:
//
//   launch -> clarify parks -> SIGKILL/restart -> answer -> review parks ->
//   SIGKILL/restart -> approve -> task done with the original run identities.

import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

interface TaskRow {
  status: string
}

interface ClarifySummary {
  taskId: string
  askingNodeId: string
  intermediaryNodeRunId: string
  iteration: number
  questionCount: number
  status: string
}

interface ReviewSummary {
  taskId: string
  nodeRunId: string
  reviewIteration: number
  awaitingReview: boolean
}

interface TaskQuestionSummary {
  id: string
  phase: string
  staged: boolean
  sealed: boolean
}

type DecisionBarrierKind = 'review' | 'clarify' | 'questions'

interface DecisionBarrierMarker {
  kind: DecisionBarrierKind
  taskId: string
  operationId: string
  committedAt: number
}

function expectOk(response: Response, label: string): void {
  if (response.ok) return
  throw new Error(`${label}: HTTP ${response.status}`)
}

async function taskStatus(daemon: DaemonHandle, taskId: string): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expectOk(response, `GET task ${taskId}`)
  return ((await response.json()) as TaskRow).status
}

async function waitForTaskStatus(
  daemon: DaemonHandle,
  taskId: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await taskStatus(daemon, taskId)
    if (last === expected) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`task ${taskId} never reached ${expected}; last=${last}`)
}

async function pendingClarify(
  daemon: DaemonHandle,
  taskId: string,
  timeoutMs = 15_000,
): Promise<ClarifySummary> {
  const deadline = Date.now() + timeoutMs
  let last: ClarifySummary | undefined
  while (Date.now() < deadline) {
    const response = await fetch(
      `${daemon.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${daemon.token}` } },
    )
    if (response.ok) {
      const rows = (await response.json()) as ClarifySummary[]
      last = rows.find((row) => row.taskId === taskId)
      if (last !== undefined) return last
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`clarify gate did not reappear for ${taskId}; last=${JSON.stringify(last)}`)
}

async function pendingReview(
  daemon: DaemonHandle,
  taskId: string,
  timeoutMs = 30_000,
): Promise<ReviewSummary> {
  const deadline = Date.now() + timeoutMs
  let last: ReviewSummary | undefined
  while (Date.now() < deadline) {
    const response = await fetch(`${daemon.baseUrl}/api/reviews?status=pending`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (response.ok) {
      const rows = (await response.json()) as ReviewSummary[]
      last = rows.find((row) => row.taskId === taskId)
      if (last?.awaitingReview === true) return last
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`review gate did not reappear for ${taskId}; last=${JSON.stringify(last)}`)
}

async function waitForDecisionCommitBarrier(
  barrierDir: string,
  kind: DecisionBarrierKind,
  timeoutMs = 15_000,
): Promise<DecisionBarrierMarker> {
  const markerPath = join(barrierDir, `${kind}.committed.json`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return JSON.parse(readFileSync(markerPath, 'utf8')) as DecisionBarrierMarker
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`${kind} decision never reached the committed-before-wake barrier`)
}

function crashBarrierEnv(barrierDir: string, kind: DecisionBarrierKind): Record<string, string> {
  return {
    AW_E2E_HUMAN_GATE_DECISION_BARRIER_DIR: barrierDir,
    AW_E2E_HUMAN_GATE_DECISION_BARRIER_KIND: kind,
  }
}

function observeInterruptedRequest(request: Promise<Response>): Promise<'response' | 'error'> {
  return request.then(
    () => 'response' as const,
    () => 'error' as const,
  )
}

async function seedWorkflow(daemon: DaemonHandle): Promise<string> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'rfc294-human-gate-restart-agent'
  const agentResponse = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'Asks once, then emits markdown for a persisted review gate.',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: 'RFC-294 restart compatibility fixture.',
    }),
  })
  expectOk(agentResponse, 'create restart agent')
  const agent = (await agentResponse.json()) as { id: string }

  const workflowResponse = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'rfc294-human-gate-restart',
      description: 'Clarify and review survive two daemon replacements.',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: 'Design {{topic}}.',
            position: { x: 280, y: 0 },
          },
          {
            id: 'clarify',
            kind: 'clarify',
            title: 'Clarify design',
            description: 'Persist this gate across daemon replacement.',
            position: { x: 500, y: 180 },
          },
          {
            id: 'review',
            kind: 'review',
            title: 'Review design',
            description: 'Persist this gate across a second replacement.',
            inputSource: { nodeId: 'designer', portName: 'design' },
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
            rollbackFilesOnReject: false,
            rollbackFilesOnIterate: false,
            position: { x: 620, y: 0 },
          },
          {
            id: 'output',
            kind: 'output',
            ports: [{ name: 'doc', bind: { nodeId: 'review', portName: 'approved_doc' } }],
            position: { x: 920, y: 0 },
          },
        ],
        edges: [
          {
            id: 'input-designer',
            source: { nodeId: 'input', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
          {
            id: 'designer-clarify',
            source: { nodeId: 'designer', portName: '__clarify__' },
            target: { nodeId: 'clarify', portName: 'questions' },
          },
          {
            id: 'clarify-designer',
            source: { nodeId: 'clarify', portName: 'answers' },
            target: { nodeId: 'designer', portName: '__clarify_response__' },
          },
          {
            id: 'designer-review',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'review', portName: '__review_input__' },
          },
          {
            id: 'review-output',
            source: { nodeId: 'review', portName: 'approved_doc' },
            target: { nodeId: 'output', portName: 'doc' },
          },
        ],
      },
    }),
  })
  expectOk(workflowResponse, 'create restart workflow')
  return ((await workflowResponse.json()) as { id: string }).id
}

async function launchWorkflowTask(
  daemon: DaemonHandle,
  workflowId: string,
  repoDir: string,
  name: string,
  topic: string,
): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflowId,
      name,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic },
    }),
  })
  expectOk(response, `launch ${name}`)
  return ((await response.json()) as { id: string }).id
}

test('clarify and review keep their durable identities across separate daemon crashes', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc294-gate-restart-repo-'))
  const stubState = mkdtempSync(join(tmpdir(), 'aw-rfc294-gate-restart-stub-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-294 human gate restart\n', 'utf8')
  initGitRepo(repoDir)

  let daemonA: DaemonHandle | undefined
  let daemonB: DaemonHandle | undefined
  let daemonC: DaemonHandle | undefined
  let home: string | undefined
  try {
    daemonA = await startDaemon({
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })
    home = daemonA.home
    const workflowId = await seedWorkflow(daemonA)
    const launchResponse = await fetch(`${daemonA.baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemonA.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workflowId,
        name: 'rfc294-human-gate-restart-task',
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
        inputs: { topic: 'durable bounded-context migration' },
      }),
    })
    expectOk(launchResponse, 'launch restart task')
    const taskId = ((await launchResponse.json()) as { id: string }).id

    await waitForTaskStatus(daemonA, taskId, 'awaiting_human')
    const clarifyBeforeCrash = await pendingClarify(daemonA, taskId)
    expect(clarifyBeforeCrash.askingNodeId).toBe('designer')
    expect(clarifyBeforeCrash.iteration).toBe(0)
    expect(clarifyBeforeCrash.questionCount).toBe(2)

    await daemonA.killChild('SIGKILL')
    daemonA = undefined
    daemonB = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })

    // A parked task owns no live runtime process. Boot recovery must preserve
    // the gate instead of converting it to interrupted/canceled or re-minting it.
    expect(await taskStatus(daemonB, taskId)).toBe('awaiting_human')
    const clarifyAfterRestart = await pendingClarify(daemonB, taskId)
    expect(clarifyAfterRestart.intermediaryNodeRunId).toBe(clarifyBeforeCrash.intermediaryNodeRunId)
    expect(clarifyAfterRestart.iteration).toBe(clarifyBeforeCrash.iteration)

    const answerResponse = await fetch(
      `${daemonB.baseUrl}/api/clarify/${clarifyAfterRestart.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonB.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-db',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
            {
              questionId: 'q-lang',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'stop',
          ifMatchIteration: clarifyAfterRestart.iteration,
        }),
      },
    )
    expectOk(answerResponse, 'answer clarify after restart')
    expect((await answerResponse.json()) as { ok: boolean }).toMatchObject({ ok: true })

    const reviewBeforeCrash = await pendingReview(daemonB, taskId)
    expect(reviewBeforeCrash.reviewIteration).toBe(0)
    await daemonB.killChild('SIGKILL')
    daemonB = undefined
    daemonC = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })

    expect(await taskStatus(daemonC, taskId)).toBe('awaiting_review')
    const reviewAfterRestart = await pendingReview(daemonC, taskId)
    expect(reviewAfterRestart.nodeRunId).toBe(reviewBeforeCrash.nodeRunId)
    expect(reviewAfterRestart.reviewIteration).toBe(reviewBeforeCrash.reviewIteration)

    const approveResponse = await fetch(
      `${daemonC.baseUrl}/api/reviews/${reviewAfterRestart.nodeRunId}/decision`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonC.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
      },
    )
    expectOk(approveResponse, 'approve review after restart')
    await waitForTaskStatus(daemonC, taskId, 'done')

    // The final read crosses the task query adapter and proves continuation
    // completed the original rows rather than merely flipping the task status.
    const runsResponse = await fetch(`${daemonC.baseUrl}/api/tasks/${taskId}/node-runs`, {
      headers: { Authorization: `Bearer ${daemonC.token}` },
    })
    expectOk(runsResponse, 'read final node runs')
    const execution = (await runsResponse.json()) as {
      runs: Array<{ id: string; nodeId: string; status: string }>
      outputs: Array<{ port: string; value: string }>
    }
    expect(
      execution.runs.find((run) => run.id === clarifyAfterRestart.intermediaryNodeRunId),
    ).toMatchObject({ nodeId: 'clarify', status: 'done' })
    expect(execution.runs.find((run) => run.id === reviewAfterRestart.nodeRunId)).toMatchObject({
      nodeId: 'review',
      status: 'done',
    })
    expect(execution.outputs.some((output) => output.port === 'doc')).toBe(true)
  } finally {
    if (daemonC !== undefined) await daemonC.stop()
    if (daemonB !== undefined) await daemonB.stop()
    if (daemonA !== undefined) await daemonA.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(stubState, { recursive: true, force: true })
  }
})

test('clarify and review continuations recover when SIGKILL lands after commit but before wake', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc333-decision-restart-repo-'))
  const stubState = mkdtempSync(join(tmpdir(), 'aw-rfc333-decision-restart-stub-'))
  const barrierDir = mkdtempSync(join(tmpdir(), 'aw-rfc333-decision-restart-barrier-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-333 decision restart\n', 'utf8')
  initGitRepo(repoDir)

  let daemonA: DaemonHandle | undefined
  let daemonB: DaemonHandle | undefined
  let daemonC: DaemonHandle | undefined
  let home: string | undefined
  try {
    daemonA = await startDaemon({
      stubMode: 'clarify',
      extraEnv: {
        CLARIFY_STUB_STATE: stubState,
        ...crashBarrierEnv(barrierDir, 'clarify'),
      },
    })
    home = daemonA.home
    const workflowId = await seedWorkflow(daemonA)
    const taskId = await launchWorkflowTask(
      daemonA,
      workflowId,
      repoDir,
      'rfc333-clarify-review-decision-restart',
      'recover committed clarify and review decisions',
    )
    await waitForTaskStatus(daemonA, taskId, 'awaiting_human')
    const clarify = await pendingClarify(daemonA, taskId)

    const answerRequest = observeInterruptedRequest(
      fetch(`${daemonA.baseUrl}/api/clarify/${clarify.intermediaryNodeRunId}/answers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonA.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'rfc333-e2e-clarify-commit-wake',
        },
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-db',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
            {
              questionId: 'q-lang',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'stop',
          ifMatchIteration: clarify.iteration,
        }),
      }),
    )
    expect(await waitForDecisionCommitBarrier(barrierDir, 'clarify')).toMatchObject({ taskId })
    await daemonA.killChild('SIGKILL')
    daemonA = undefined
    expect(await answerRequest).toBe('error')

    daemonB = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: {
        CLARIFY_STUB_STATE: stubState,
        ...crashBarrierEnv(barrierDir, 'review'),
      },
    })
    const review = await pendingReview(daemonB, taskId)
    const approveRequest = observeInterruptedRequest(
      fetch(`${daemonB.baseUrl}/api/reviews/${review.nodeRunId}/decision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonB.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'rfc333-e2e-review-commit-wake',
        },
        body: JSON.stringify({ decision: 'approved', reviewIteration: review.reviewIteration }),
      }),
    )
    expect(await waitForDecisionCommitBarrier(barrierDir, 'review')).toMatchObject({ taskId })
    await daemonB.killChild('SIGKILL')
    daemonB = undefined
    expect(await approveRequest).toBe('error')

    daemonC = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })
    await waitForTaskStatus(daemonC, taskId, 'done')
    const runsResponse = await fetch(`${daemonC.baseUrl}/api/tasks/${taskId}/node-runs`, {
      headers: { Authorization: `Bearer ${daemonC.token}` },
    })
    expectOk(runsResponse, 'read recovered clarify/review node runs')
    const runs = ((await runsResponse.json()) as { runs: Array<{ id: string; status: string }> })
      .runs
    expect(runs.find((run) => run.id === clarify.intermediaryNodeRunId)?.status).toBe('done')
    expect(runs.find((run) => run.id === review.nodeRunId)?.status).toBe('done')
  } finally {
    if (daemonC !== undefined) await daemonC.stop()
    if (daemonB !== undefined) await daemonB.stop()
    if (daemonA !== undefined) await daemonA.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(stubState, { recursive: true, force: true })
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('question dispatch recovers the committed continuation after SIGKILL before wake', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc333-question-restart-repo-'))
  const stubState = mkdtempSync(join(tmpdir(), 'aw-rfc333-question-restart-stub-'))
  const barrierDir = mkdtempSync(join(tmpdir(), 'aw-rfc333-question-restart-barrier-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-333 question restart\n', 'utf8')
  initGitRepo(repoDir)

  let daemonA: DaemonHandle | undefined
  let daemonB: DaemonHandle | undefined
  let daemonC: DaemonHandle | undefined
  let home: string | undefined
  try {
    daemonA = await startDaemon({
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })
    home = daemonA.home
    const workflowId = await seedWorkflow(daemonA)
    const taskId = await launchWorkflowTask(
      daemonA,
      workflowId,
      repoDir,
      'rfc333-question-decision-restart',
      'recover a committed question dispatch',
    )
    await waitForTaskStatus(daemonA, taskId, 'awaiting_human')
    const clarify = await pendingClarify(daemonA, taskId)

    const sealResponse = await fetch(
      `${daemonA.baseUrl}/api/clarify/${clarify.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonA.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-db',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
            {
              questionId: 'q-lang',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'stop',
          defer: true,
          ifMatchIteration: clarify.iteration,
        }),
      },
    )
    expectOk(sealResponse, 'seal clarify questions without releasing the gate')
    expect((await sealResponse.json()) as { kind: string }).toMatchObject({ kind: 'seal' })

    const questionsResponse = await fetch(`${daemonA.baseUrl}/api/tasks/${taskId}/questions`, {
      headers: { Authorization: `Bearer ${daemonA.token}` },
    })
    expectOk(questionsResponse, 'list staged task questions')
    const questions = (await questionsResponse.json()) as TaskQuestionSummary[]
    const stagedIds = questions
      .filter((row) => row.phase === 'staged' && row.staged && row.sealed)
      .map((row) => row.id)
    expect(stagedIds.length).toBeGreaterThan(0)

    await daemonA.killChild('SIGKILL')
    daemonA = undefined
    daemonB = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: {
        CLARIFY_STUB_STATE: stubState,
        ...crashBarrierEnv(barrierDir, 'questions'),
      },
    })
    expect(await taskStatus(daemonB, taskId)).toBe('awaiting_human')
    const dispatchRequest = observeInterruptedRequest(
      fetch(`${daemonB.baseUrl}/api/tasks/${taskId}/questions/dispatch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonB.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'rfc333-e2e-questions-commit-wake',
        },
        body: JSON.stringify({ entryIds: stagedIds }),
      }),
    )
    expect(await waitForDecisionCommitBarrier(barrierDir, 'questions')).toMatchObject({ taskId })
    await daemonB.killChild('SIGKILL')
    daemonB = undefined
    expect(await dispatchRequest).toBe('error')

    daemonC = await startDaemon({
      home,
      stubMode: 'clarify',
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })
    const review = await pendingReview(daemonC, taskId)
    const approveResponse = await fetch(
      `${daemonC.baseUrl}/api/reviews/${review.nodeRunId}/decision`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemonC.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', reviewIteration: review.reviewIteration }),
      },
    )
    expectOk(approveResponse, 'approve review after question continuation recovery')
    await waitForTaskStatus(daemonC, taskId, 'done')
  } finally {
    if (daemonC !== undefined) await daemonC.stop()
    if (daemonB !== undefined) await daemonB.stop()
    if (daemonA !== undefined) await daemonA.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(stubState, { recursive: true, force: true })
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

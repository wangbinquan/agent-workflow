// RFC-056 PR-D T10 — cross-clarify e2e (A1 happy path). Updated for RFC-162.
//
// Drives a workflow with a designer + questioner + cross-clarify node through
// the full ask → user-answers → QUESTIONER-rerun-with-Q&A → final-output cycle.
// API-driven so we exercise the real runtime path (daemon + scheduler +
// crossClarify service + DB + WS).
//
// RFC-162 (反问机制完全归一): a cross-clarify submit now reruns the QUESTIONER
// (the asker / single default card) with the Q&A injected — NOT the designer.
// "Designer-by-default" was removed; making the upstream designer revise is now
// an explicit reassign, not the default. So the designer runs exactly ONCE here.
//
// The (agent-driven) stub in e2e/fixtures/stub-opencode-cross-clarify.sh emits,
// under RFC-162's questioner-rerun sequence:
//   designer round 1    → <workflow-output> "design v1"   (runs ONCE)
//   questioner round 1  → <workflow-clarify> (1 question)
//   ★ task pauses awaiting_human; user POSTs answers (continue) ★
//   questioner round 2  → <workflow-clarify> AGAIN (RFC-100 ask-back), prompt
//                          now carries the flat `## Clarify Q&A` block
//   ★ pauses; user POSTs answers (stop) ★
//   questioner round 3  → <workflow-output> "questioner v3"
//
// LOCKS (in addition to status transitions):
//   * GET /api/clarify returns a cross-tagged entry while awaiting_human.
//   * The QUESTIONER round 2 prompt (captured via CROSS_CLARIFY_PROMPT_LOG)
//     contains the flat `## Clarify Q&A` block — proves the framework injected
//     the user's submitted Q&A into the ASKER's rerun (RFC-132 PR-C single-block
//     format). The designer NEVER reruns (no `designer round 2`).

import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
const stubCrossClarify = resolve(here, 'fixtures', 'stub-opencode-cross-clarify.sh')

interface CrossClarifyInboxEntry {
  // RFC-058 T14/T16: REST /api/clarify now returns ClarifyRoundSummary
  // (unified shape). The cross-clarify rows carry `kind: 'cross'` and the
  // legacy field names map as follows:
  //   crossClarifyNodeId   → intermediaryNodeId
  //   crossClarifyNodeRunId→ intermediaryNodeRunId
  //   sourceQuestionerNodeId → askingNodeId
  //   targetDesignerNodeId → targetConsumerNodeId
  kind: 'cross'
  id: string
  taskId: string
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  askingNodeId: string
  targetConsumerNodeId: string | null
  iteration: number
  questionCount: number
  status: string
  directive: string | null
}

interface ClarifyInboxItem {
  kind?: 'self' | 'cross'
}

interface TaskRow {
  status: string
}

function expectOk(res: Response, what: string): void {
  if (!res.ok) {
    throw new Error(`e2e setup: ${what} failed: HTTP ${res.status}`)
  }
}

async function pollTaskStatus(
  d: DaemonHandle,
  taskId: string,
  predicate: (t: TaskRow) => boolean,
  timeoutMs: number,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow = { status: 'pending' }
  while (Date.now() < deadline) {
    const res = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (res.ok) {
      last = (await res.json()) as TaskRow
      if (predicate(last)) return last
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollTaskStatus: timeout — last=${JSON.stringify(last)}`)
}

async function pollCrossClarifyAwaiting(
  d: DaemonHandle,
  taskId: string,
  timeoutMs: number,
): Promise<CrossClarifyInboxEntry> {
  const deadline = Date.now() + timeoutMs
  let last: ClarifyInboxItem[] = []
  while (Date.now() < deadline) {
    const res = await fetch(
      `${d.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${d.token}` } },
    )
    if (res.ok) {
      last = (await res.json()) as ClarifyInboxItem[]
      const row = last.find(
        (r): r is CrossClarifyInboxEntry => (r as { kind?: string }).kind === 'cross',
      )
      if (row !== undefined) return row
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollCrossClarifyAwaiting: timeout — last=${JSON.stringify(last)}`)
}

test.describe('RFC-056 cross-clarify e2e — A1 happy path', () => {
  let daemon: DaemonHandle
  let repoDir: string
  let stubState: string
  let promptLog: string
  let fixtures: { workflowId: string; repoPath: string }

  test.beforeAll(async () => {
    stubState = mkdtempSync(join(tmpdir(), 'aw-e2e-cross-clarify-state-'))
    promptLog = join(stubState, 'prompt.log')
    daemon = await startDaemon({
      stubOpencode: stubCrossClarify,
      extraEnv: {
        CROSS_CLARIFY_STUB_STATE: stubState,
        CROSS_CLARIFY_PROMPT_LOG: promptLog,
      },
    })

    repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-cross-clarify-repo-'))
    writeFileSync(join(repoDir, 'README.md'), '# cross-clarify e2e fixture\n', 'utf-8')
    initGitRepo(repoDir)

    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    const designerRes = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'designer',
        description: 'e2e cross-clarify designer',
        outputs: ['design'],
        outputKinds: { design: 'markdown' },
        readonly: true,
        bodyMd: 'Stub designer for cross-clarify e2e.',
      }),
    })
    expectOk(designerRes, 'create designer agent')
    const designer = (await designerRes.json()) as { id: string }
    const questionerRes = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'questioner',
        description: 'e2e cross-clarify questioner',
        outputs: ['main'],
        outputKinds: { main: 'markdown' },
        readonly: true,
        bodyMd: 'Stub questioner for cross-clarify e2e.',
      }),
    })
    expectOk(questionerRes, 'create questioner agent')
    const questioner = (await questionerRes.json()) as { id: string }

    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'e2e-cross-clarify-happy',
        description: 'Generated by Playwright e2e (RFC-056 PR-D T10).',
        definition: {
          $schema_version: 4,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: designer.id,
              agentName: 'designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 220, y: 0 },
            },
            {
              id: 'questioner',
              kind: 'agent-single',
              agentId: questioner.id,
              agentName: 'questioner',
              promptTemplate: 'Review {{designer.design}}.',
              position: { x: 440, y: 0 },
            },
            {
              id: 'cross1',
              kind: 'clarify-cross-agent',
              title: 'Cross clarify',
              description: 'questioner asks user; user feeds back to designer.',
              position: { x: 440, y: 160 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'design', bind: { nodeId: 'designer', portName: 'design' } }],
              position: { x: 660, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_designer',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'designer', portName: 'topic' },
            },
            {
              id: 'e_designer_questioner',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'questioner', portName: 'design' },
            },
            // cross-clarify auto-edges
            {
              id: 'e_questioner_cross',
              source: { nodeId: 'questioner', portName: '__clarify__' },
              target: { nodeId: 'cross1', portName: 'questions' },
            },
            {
              id: 'e_cross_to_questioner',
              source: { nodeId: 'cross1', portName: 'to_questioner' },
              target: { nodeId: 'questioner', portName: '__clarify_response__' },
            },
            // manual edge cross → designer
            {
              id: 'e_cross_to_designer',
              source: { nodeId: 'cross1', portName: 'to_designer' },
              target: { nodeId: 'designer', portName: '__external_feedback__' },
            },
            // designer → output
            {
              id: 'e_designer_out',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'out_1', portName: 'design' },
            },
          ],
        },
      }),
    })
    expectOk(wfRes, 'create workflow')
    const workflow = (await wfRes.json()) as { id: string }

    fixtures = { workflowId: workflow.id, repoPath: repoDir }
  })

  test.afterAll(async () => {
    try {
      rmSync(repoDir, { recursive: true, force: true })
      rmSync(stubState, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (daemon !== undefined) await daemon.stop()
  })

  test('full cycle: launch → questioner emits cross-clarify → user submits → questioner reruns with the Q&A (RFC-162: designer does NOT rerun by default) → done', async () => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }

    // 1. Launch task.
    const launchRes = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: fixtures.workflowId,
        name: 'e2e-cross-clarify-task',
        repoUrl: pathToFileURL(fixtures.repoPath).href,
        ref: 'main',
        inputs: { topic: 'cache eviction strategy' },
      }),
    })
    expectOk(launchRes, 'launch task')
    const taskId = ((await launchRes.json()) as { id: string }).id

    // 2. Task pauses awaiting_human after questioner.first emits cross-clarify.
    const awaiting = await pollTaskStatus(
      daemon,
      taskId,
      (t) => t.status === 'awaiting_human',
      30_000,
    )
    expect(awaiting.status).toBe('awaiting_human')

    // 3. /api/clarify list surfaces a cross-tagged entry.
    const row = await pollCrossClarifyAwaiting(daemon, taskId, 10_000)
    expect(row.kind).toBe('cross')
    expect(row.intermediaryNodeId).toBe('cross1')
    expect(row.askingNodeId).toBe('questioner')
    expect(row.targetConsumerNodeId).toBe('designer')
    expect(row.questionCount).toBe(1)

    // 4. POST answers (directive='continue').
    const submitRes = await fetch(
      `${daemon.baseUrl}/api/clarify/${row.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-redis',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'continue',
          ifMatchIteration: row.iteration,
        }),
      },
    )
    expectOk(submitRes, 'POST cross-clarify answers')

    // 4b. RFC-100: the cross-clarify questioner is MANDATORY ask-back — a
    //     'continue' answer makes it ask AGAIN (it may not finalize with
    //     <workflow-output> until the user clicks "Stop clarifying"). RFC-162:
    //     it is the QUESTIONER (the asker) that reruns with the Q&A on a plain
    //     cross submit — the designer does not (asserted at step 6/7).
    //     Poll for the questioner's second cross-clarify round and answer it
    //     with 'stop' so the questioner finalizes and the task can complete.
    const row2 = await pollCrossClarifyAwaiting(daemon, taskId, 30_000)
    expect(row2.askingNodeId).toBe('questioner')
    expect(row2.intermediaryNodeRunId).not.toBe(row.intermediaryNodeRunId)
    const submitRes2 = await fetch(
      `${daemon.baseUrl}/api/clarify/${row2.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-redis',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'stop',
          ifMatchIteration: row2.iteration,
        }),
      },
    )
    expectOk(submitRes2, 'POST cross-clarify answers (stop)')

    // 5. Task reaches terminal done after the designer's external-feedback rerun
    //    and the questioner's stop-released final output.
    const final = await pollTaskStatus(daemon, taskId, (t) => t.status === 'done', 30_000)
    expect(final.status).toBe('done')

    // 6. RFC-162: the ASKER (questioner) — NOT the designer — reruns with the Q&A. Cross-clarify is
    //    now a single questioner card by default (designer-by-default removed); "let the upstream
    //    designer revise" is an explicit reassign, not the default. So the framework injects the
    //    user's submitted Q&A into the QUESTIONER's rerun prompt (round 2, the continue-answer
    //    cascade), as the flat `## Clarify Q&A` block (RFC-132 PR-C single-block format is unchanged).
    const log = readFileSync(promptLog, 'utf-8')
    const questionerRound2 = log.match(
      /=== questioner round 2 ===([\s\S]*?)=== END questioner round 2 ===/,
    )
    expect(questionerRound2, 'questioner round 2 prompt was logged').not.toBeNull()
    expect(questionerRound2![1]).toContain('## Clarify Q&A')
    // The designer NEVER reran — RFC-162 removed the designer-by-default entry, so a plain cross
    // submit reruns only the questioner. (A prior version of this spec asserted a designer round 2;
    // that was the pre-RFC-162 scope=designer behavior.)
    expect(log).not.toContain('=== designer round 2 ===')

    // 7. Node-runs confirm RFC-162: the QUESTIONER reran (>= 2 top-level questioner runs) while the
    //    designer ran exactly ONCE (no designer-by-default rerun on a plain cross submit).
    const runsRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/node-runs`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expectOk(runsRes, 'GET task node-runs')
    const runs = (await runsRes.json()) as {
      runs: Array<{
        id: string
        nodeId: string
        parentNodeRunId: string | null
        status: string
      }>
    }
    const topLevelDesigners = runs.runs.filter(
      (r) => r.nodeId === 'designer' && r.parentNodeRunId === null,
    )
    expect(topLevelDesigners.length, 'designer ran exactly once (no default rerun)').toBe(1)
    const questionerRuns = runs.runs.filter(
      (r) => r.nodeId === 'questioner' && r.parentNodeRunId === null,
    )
    expect(questionerRuns.length, 'questioner reran (>= 2 top-level runs)').toBeGreaterThanOrEqual(
      2,
    )
  })
})

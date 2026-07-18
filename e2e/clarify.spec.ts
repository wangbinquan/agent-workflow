// RFC-023 PR-D T28 + T29 — full clarify-cycle e2e.
//
// Drives a workflow with a clarify node through the ask → user-answers →
// agent-rerun → final-output cycle. API-driven so we exercise the real
// runtime path (daemon + scheduler + clarify service + DB + WS). The UI
// surfaces are covered by component tests (QuestionForm, list/detail
// routes, draftStore).
//
// The stub binary in e2e/fixtures/stub-opencode-clarify.sh emits a
// <workflow-clarify> envelope on first invocation per (agent, shard_key),
// then a <workflow-output> envelope on subsequent invocations — so the
// scheduler walks awaiting_human → done after the user POSTs answers.
//
// T28 — agent-single happy path:
//   input → designer(agent-single) → clarify_design → reviewDesign(review)
//   First designer call clarifies → POST answers → designer reruns → review
//   awaits → approve → task done.
//
// T29 — agent-multi shard fanout:
//   input(diff) → wrapper-git? No — we feed a synthetic 3-file diff so the
//   per-file split lands 3 shards. Only the middle shard's stub call asks
//   back (CLARIFY_STUB_ASK_SHARDS="shard_B"). The other two shards finish
//   in one round. The user answers the one awaiting session → shard reruns
//   → parent aggregates → task done.

import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
const stubClarify = resolve(here, 'fixtures', 'stub-opencode-clarify.sh')

interface ClarifySessionRow {
  // RFC-058 T14/T16: REST returns ClarifyRoundSummary; field paths renamed:
  //   sourceAgentNodeId  → askingNodeId
  //   sourceShardKey     → askingShardKey
  //   clarifyNodeId      → intermediaryNodeId
  //   clarifyNodeRunId   → intermediaryNodeRunId
  //   iterationIndex     → iteration
  id: string
  taskId: string
  kind: 'self' | 'cross'
  askingNodeId: string
  askingShardKey: string | null
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  iteration: number
  questionCount: number
  status: string
  createdAt: number
  answeredAt: number | null
}

interface TaskRow {
  status: string
}

interface ReviewSummaryRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
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

async function pollClarifySession(
  d: DaemonHandle,
  taskId: string,
  predicate: (rows: ClarifySessionRow[]) => boolean,
  timeoutMs: number,
): Promise<ClarifySessionRow[]> {
  const deadline = Date.now() + timeoutMs
  let last: ClarifySessionRow[] = []
  while (Date.now() < deadline) {
    const res = await fetch(
      `${d.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${d.token}` } },
    )
    if (res.ok) {
      last = (await res.json()) as ClarifySessionRow[]
      if (predicate(last)) return last
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollClarifySession: timeout — last=${JSON.stringify(last)}`)
}

async function pollPendingReview(
  d: DaemonHandle,
  taskId: string,
  timeoutMs: number,
): Promise<ReviewSummaryRow> {
  const deadline = Date.now() + timeoutMs
  let last: ReviewSummaryRow | null = null
  while (Date.now() < deadline) {
    const res = await fetch(`${d.baseUrl}/api/reviews?status=pending`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (res.ok) {
      const all = (await res.json()) as ReviewSummaryRow[]
      const row = all.find((r) => r.taskId === taskId)
      if (row !== undefined && row.awaitingReview) return row
      last = row ?? last
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollPendingReview: timeout — last=${JSON.stringify(last)}`)
}

// ---------------------------------------------------------------------------
// T28 — agent-single clarify cycle (with downstream review).
// ---------------------------------------------------------------------------

test.describe('RFC-023 clarify e2e — agent-single happy path', () => {
  let daemon: DaemonHandle
  let repoDir: string
  let stubState: string
  let fixtures: { workflowId: string; repoPath: string; agentName: string; clarifyNodeId: string }

  test.beforeAll(async () => {
    stubState = mkdtempSync(join(tmpdir(), 'aw-e2e-clarify-state-'))
    daemon = await startDaemon({
      stubOpencode: stubClarify,
      extraEnv: { CLARIFY_STUB_STATE: stubState },
    })

    repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-clarify-repo-'))
    writeFileSync(join(repoDir, 'README.md'), '# clarify e2e fixture\n', 'utf-8')
    initGitRepo(repoDir)

    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    const agentName = 'e2e-clarify-designer'
    expectOk(
      await fetch(`${daemon.baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: agentName,
          description: 'e2e clarify designer',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: 'Stub designer for clarify e2e.',
        }),
      }),
      'create agent',
    )

    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'e2e-clarify-cycle',
        description: 'Generated by Playwright e2e (RFC-023 PR-D T28).',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentName,
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'clarify_1',
              kind: 'clarify',
              title: 'Clarify design',
              description: 'Designer asks before producing the doc.',
              position: { x: 560, y: 160 },
            },
            {
              id: 'review_design',
              kind: 'review',
              title: 'review design',
              description: '',
              inputSource: { nodeId: 'designer', portName: 'design' },
              rerunnableOnReject: [],
              rerunnableOnIterate: [],
              rollbackFilesOnReject: false,
              rollbackFilesOnIterate: false,
              position: { x: 640, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'doc', bind: { nodeId: 'review_design', portName: 'approved_doc' } }],
              position: { x: 960, y: 0 },
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
              id: 'e_designer_review',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'review_design', portName: 'doc' },
            },
            {
              id: 'e_review_out',
              source: { nodeId: 'review_design', portName: 'approved_doc' },
              target: { nodeId: 'out_1', portName: 'doc' },
            },
          ],
        },
      }),
    })
    expectOk(wfRes, 'create workflow')
    const workflow = (await wfRes.json()) as { id: string }

    fixtures = {
      workflowId: workflow.id,
      repoPath: repoDir,
      agentName,
      clarifyNodeId: 'clarify_1',
    }
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

  test('cycle: launch → awaiting_human → POST answers → designer reruns → review approve → done', async () => {
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
        name: 'e2e-fixture-task',
        repoUrl: pathToFileURL(fixtures.repoPath).href,
        ref: 'main',
        inputs: { topic: 'order_status enum' },
      }),
    })
    expectOk(launchRes, 'launch task')
    const launched = (await launchRes.json()) as { id: string }
    const taskId = launched.id

    // 2. Task should pause awaiting_human after designer's first envelope.
    const awaiting = await pollTaskStatus(
      daemon,
      taskId,
      (t) => t.status === 'awaiting_human',
      30_000,
    )
    expect(awaiting.status).toBe('awaiting_human')

    // 3. The clarify list endpoint should surface exactly one session for this task.
    const rows = await pollClarifySession(daemon, taskId, (r) => r.length >= 1, 5_000)
    expect(rows.length).toBe(1)
    const session = rows[0]!
    expect(session.askingNodeId).toBe('designer')
    expect(session.intermediaryNodeId).toBe(fixtures.clarifyNodeId)
    expect(session.askingShardKey).toBeNull()
    expect(session.iteration).toBe(0)
    expect(session.questionCount).toBe(2)

    // 4. Detail endpoint returns both questions with options + recommended flag.
    const detailRes = await fetch(
      `${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}`,
      {
        headers: { Authorization: `Bearer ${daemon.token}` },
      },
    )
    expectOk(detailRes, 'GET clarify detail')
    const detail = (await detailRes.json()) as {
      questions: Array<{
        id: string
        recommended: boolean
        options: Array<{
          label: string
          description: string
          recommended: boolean
          recommendationReason: string
        }>
        kind: string
      }>
    }
    expect(detail.questions.map((q) => q.id).sort()).toEqual(['q-db', 'q-lang'])
    const qDb = detail.questions.find((q) => q.id === 'q-db')!
    // RFC-023 iter #2: options are now objects ({label, description, recommended, reason}).
    // Backward-compat: strings emitted by the stub are lifted to objects with empty defaults.
    expect(qDb.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite'])

    // 5. Submit answers — pick Postgres + check TypeScript.
    const submitRes = await fetch(
      `${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers,
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
          // RFC-100: stop releases the designer from mandatory ask-back so its rerun outputs.
          directive: 'stop',
          ifMatchIteration: session.iteration,
        }),
      },
    )
    expectOk(submitRes, 'POST clarify answers')
    // RFC-132 PR-B/PR-C: submitting answers now flows through the unified
    // autoDispatchClarifyRound path (seal → dispatch), so the response is the
    // `autodispatch` envelope — NOT the legacy { session, rerunNodeRunId }.
    // (routes/clarify.ts returns { ok, kind:'autodispatch', roundFullySealed,
    // sealedQuestionIds, reruns, ... }.)
    const submit = (await submitRes.json()) as {
      ok: boolean
      kind: string
      roundFullySealed: boolean
      sealedQuestionIds: string[]
      reruns: Array<{ nodeRunId: string }>
    }
    expect(submit.ok).toBe(true)
    expect(submit.kind).toBe('autodispatch')
    // Both questions were answered in one shot → the round fully seals.
    expect(submit.roundFullySealed).toBe(true)
    expect([...submit.sealedQuestionIds].sort()).toEqual(['q-db', 'q-lang'])
    // A rerun of the asking agent is minted + dispatched (step 6 below proves it
    // actually reran by polling for the pending review).
    expect(Array.isArray(submit.reruns)).toBe(true)

    // Server-side sealing turns indices back into labels — this defends against
    // malicious clients sending arbitrary label strings. The autodispatch
    // envelope no longer echoes the sealed answers, so re-read the round detail
    // to assert the label backfill (and the answered status) still hold.
    const sealedRes = await fetch(
      `${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}`,
      { headers: { Authorization: `Bearer ${daemon.token}` } },
    )
    expectOk(sealedRes, 'GET clarify detail after submit')
    const sealed = (await sealedRes.json()) as {
      status: string
      answers?: Array<{ questionId: string; selectedOptionLabels: string[] }>
    }
    expect(sealed.status).toBe('answered')
    expect(sealed.answers?.find((a) => a.questionId === 'q-db')?.selectedOptionLabels).toEqual([
      'Postgres',
    ])

    // 6. The task transitions out of awaiting_human; designer reruns, then the
    // review node lands awaiting_review.
    const review = await pollPendingReview(daemon, taskId, 30_000)
    expect(review.awaitingReview).toBe(true)

    // 7. Approve to finish.
    expectOk(
      await fetch(`${daemon.baseUrl}/api/reviews/${review.nodeRunId}/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
      }),
      'approve review',
    )

    // 8. Task reaches terminal done.
    const final = await pollTaskStatus(daemon, taskId, (t) => t.status === 'done', 30_000)
    expect(final.status).toBe('done')

    // 9. Pending-count for clarify is now zero (answered sessions don't count).
    const pendingCountRes = await fetch(`${daemon.baseUrl}/api/clarify/pending-count`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expectOk(pendingCountRes, 'GET pending-count')
    const pendingCount = (await pendingCountRes.json()) as { count: number }
    expect(pendingCount.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T29 — agent-multi shard fanout: 1 of 3 shards asks back.
// ---------------------------------------------------------------------------

// RFC-060 PR-E: agent-multi was removed; this suite exercises per-shard
// clarify which was explicitly deferred from PR-D to PR-D2 (wrapper-fanout
// v1 inner subgraph only supports agent-single — no clarify/review/wrapper
// kinds inside). The shard-key fanout + 1-shard-asks-back semantics still
// exist on the wrapper-fanout container, but the runner-side per-shard
// clarify mint isn't wired yet. Revive (rewrite for wrapper-fanout +
// agent-single inner) when PR-D2 lands per-shard clarify (RFC-060 D.T5).
test.describe
  .skip('RFC-023 clarify e2e — agent-multi shard fanout (deferred to RFC-060 PR-D2 per-shard clarify)', () => {
  let daemon: DaemonHandle
  let repoDir: string
  let stubState: string
  let fixtures: { workflowId: string; repoPath: string }

  test.beforeAll(async () => {
    stubState = mkdtempSync(join(tmpdir(), 'aw-e2e-clarify-multi-state-'))
    daemon = await startDaemon({
      stubOpencode: stubClarify,
      extraEnv: {
        CLARIFY_STUB_STATE: stubState,
        // Only shard "b/x.md" asks back. The diff splitter uses per-file as
        // default; shard_key for per-file is the file path itself.
        CLARIFY_STUB_ASK_SHARDS: 'b/x.md',
      },
    })

    repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-clarify-multi-repo-'))
    writeFileSync(join(repoDir, 'README.md'), '# clarify multi e2e\n', 'utf-8')
    initGitRepo(repoDir)

    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    const agentName = 'e2e-clarify-multi-designer'
    expectOk(
      await fetch(`${daemon.baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: agentName,
          description: 'e2e clarify designer (multi)',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: 'Stub designer for clarify multi e2e.',
        }),
      }),
      'create agent',
    )

    // The agent-multi node needs a `sourcePort` carrying a synthetic diff.
    // We use an input node carrying a hand-crafted 3-file unified-diff string;
    // splitDiffPerFile chops it into 3 shards keyed by file path.
    const syntheticDiff = [
      'diff --git a/a/file1.md b/a/file1.md\nnew file mode 100644\n--- /dev/null\n+++ b/a/file1.md\n@@ -0,0 +1 @@\n+a/file1\n',
      'diff --git a/b/x.md b/b/x.md\nnew file mode 100644\n--- /dev/null\n+++ b/b/x.md\n@@ -0,0 +1 @@\n+b/x\n',
      'diff --git a/c/y.md b/c/y.md\nnew file mode 100644\n--- /dev/null\n+++ b/c/y.md\n@@ -0,0 +1 @@\n+c/y\n',
    ].join('')

    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'e2e-clarify-multi',
        description: 'Generated by Playwright e2e (RFC-023 PR-D T29).',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'diff', label: 'diff', required: true }],
          nodes: [
            { id: 'in_diff', kind: 'input', inputKey: 'diff', position: { x: 0, y: 0 } },
            {
              id: 'fanout',
              kind: 'agent-multi',
              agentName,
              promptTemplate: 'Audit {{__shard_key__}}.',
              sourcePort: { nodeId: 'in_diff', portName: 'diff' },
              position: { x: 320, y: 0 },
            },
            {
              id: 'clarify_multi',
              kind: 'clarify',
              title: 'Clarify shard',
              position: { x: 540, y: 160 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'design', bind: { nodeId: 'fanout', portName: 'design' } }],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_fan',
              source: { nodeId: 'in_diff', portName: 'diff' },
              target: { nodeId: 'fanout', portName: 'diff' },
            },
            {
              id: 'e_clarify_ask',
              source: { nodeId: 'fanout', portName: '__clarify__' },
              target: { nodeId: 'clarify_multi', portName: 'questions' },
            },
            {
              id: 'e_clarify_ans',
              source: { nodeId: 'clarify_multi', portName: 'answers' },
              target: { nodeId: 'fanout', portName: '__clarify_response__' },
            },
            {
              id: 'e_fan_out',
              source: { nodeId: 'fanout', portName: 'design' },
              target: { nodeId: 'out_1', portName: 'design' },
            },
          ],
        },
      }),
    })
    expectOk(wfRes, 'create workflow')
    const workflow = (await wfRes.json()) as { id: string }

    fixtures = {
      workflowId: workflow.id,
      repoPath: repoDir,
    }
    // Capture the synthetic diff for use inside the test.
    ;(test.info() as unknown as { _clarifyDiff?: string })._clarifyDiff = syntheticDiff
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

  test('only the b/x.md shard parks awaiting_human; answering it lets the parent aggregate', async () => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    const syntheticDiff = [
      'diff --git a/a/file1.md b/a/file1.md\nnew file mode 100644\n--- /dev/null\n+++ b/a/file1.md\n@@ -0,0 +1 @@\n+a/file1\n',
      'diff --git a/b/x.md b/b/x.md\nnew file mode 100644\n--- /dev/null\n+++ b/b/x.md\n@@ -0,0 +1 @@\n+b/x\n',
      'diff --git a/c/y.md b/c/y.md\nnew file mode 100644\n--- /dev/null\n+++ b/c/y.md\n@@ -0,0 +1 @@\n+c/y\n',
    ].join('')

    // 1. Launch.
    const launchRes = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: fixtures.workflowId,
        name: 'e2e-fixture-task',
        repoUrl: pathToFileURL(fixtures.repoPath).href,
        ref: 'main',
        inputs: { diff: syntheticDiff },
      }),
    })
    expectOk(launchRes, 'launch task')
    const launched = (await launchRes.json()) as { id: string }
    const taskId = launched.id

    // 2. Task should pause awaiting_human (1 shard asked back; others finish).
    const awaiting = await pollTaskStatus(
      daemon,
      taskId,
      (t) => t.status === 'awaiting_human',
      60_000,
    )
    expect(awaiting.status).toBe('awaiting_human')

    // 3. The clarify list should show exactly ONE session — only the b/x.md shard.
    const rows = await pollClarifySession(daemon, taskId, (r) => r.length >= 1, 10_000)
    expect(rows.length).toBe(1)
    const session = rows[0]!
    expect(session.askingNodeId).toBe('fanout')
    expect(session.askingShardKey).toBe('b/x.md')

    // 4. Submit answers — Postgres + TypeScript.
    expectOk(
      await fetch(`${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}/answers`, {
        method: 'POST',
        headers,
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
          ifMatchIteration: session.iteration,
        }),
      }),
      'POST clarify answers (multi)',
    )

    // 5. Task reaches terminal done after the shard reruns + parent aggregates.
    const final = await pollTaskStatus(daemon, taskId, (t) => t.status === 'done', 60_000)
    expect(final.status).toBe('done')

    // 6. After completion the pending-count for clarify is back to zero
    // (answered sessions are excluded).
    const pendingRes = await fetch(`${daemon.baseUrl}/api/clarify/pending-count`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expectOk(pendingRes, 'GET pending-count')
    const pending = (await pendingRes.json()) as { count: number }
    expect(pending.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RFC-026 PR-B T13 — clarify inline-session mode: --session forwarding.
//
// Drives a workflow whose clarify node carries `sessionMode: 'inline'`.
// The stub binary captures every spawn's argv to disk so the test can
// assert that round 1 (the rerun after user answers) inherits the prior
// session id via `--session <id>`. Also verifies the persisted node_runs
// row carries the same `opencodeSessionId` value the stub emitted.
// ---------------------------------------------------------------------------

const stubClarifyInline = resolve(here, 'fixtures', 'stub-opencode-clarify-inline.sh')

test.describe('RFC-026 clarify e2e — inline session resume', () => {
  let daemon: DaemonHandle
  let repoDir: string
  let stubState: string
  let argvLog: string
  let fixtures: { workflowId: string; repoPath: string; clarifyNodeId: string }

  test.beforeAll(async () => {
    stubState = mkdtempSync(join(tmpdir(), 'aw-e2e-rfc026-state-'))
    argvLog = join(stubState, 'argv.log')
    daemon = await startDaemon({
      stubOpencode: stubClarifyInline,
      extraEnv: { CLARIFY_STUB_STATE: stubState, CLARIFY_INLINE_ARGV_LOG: argvLog },
    })
    repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-rfc026-repo-'))
    writeFileSync(join(repoDir, 'README.md'), '# rfc026 e2e fixture\n', 'utf-8')
    initGitRepo(repoDir)

    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    const agentName = 'e2e-rfc026-designer'
    expectOk(
      await fetch(`${daemon.baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: agentName,
          description: 'e2e rfc026 designer',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: 'Stub designer for RFC-026 e2e.',
        }),
      }),
      'create agent',
    )
    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'e2e-rfc026-inline',
        description: 'Generated by Playwright (RFC-026 PR-B T13).',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentName,
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'clarify_1',
              kind: 'clarify',
              title: 'Clarify (inline)',
              description: 'Inline session-resume clarify.',
              sessionMode: 'inline',
              position: { x: 560, y: 160 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'doc', bind: { nodeId: 'designer', portName: 'design' } }],
              position: { x: 800, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'designer', portName: 'topic' },
            },
            {
              id: 'e_ask',
              source: { nodeId: 'designer', portName: '__clarify__' },
              target: { nodeId: 'clarify_1', portName: 'questions' },
            },
            {
              id: 'e_ans',
              source: { nodeId: 'clarify_1', portName: 'answers' },
              target: { nodeId: 'designer', portName: '__clarify_response__' },
            },
            {
              id: 'e_designer_out',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'out_1', portName: 'doc' },
            },
          ],
        },
      }),
    })
    expectOk(wfRes, 'create workflow')
    const workflow = (await wfRes.json()) as { id: string }
    fixtures = { workflowId: workflow.id, repoPath: repoDir, clarifyNodeId: 'clarify_1' }
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

  test('inline rerun argv contains --session <prior-id> and node_runs persists the id', async () => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }

    // 1. Launch.
    const launchRes = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: fixtures.workflowId,
        name: 'e2e-fixture-task',
        repoUrl: pathToFileURL(fixtures.repoPath).href,
        ref: 'main',
        inputs: { topic: 'order_status enum' },
      }),
    })
    expectOk(launchRes, 'launch task')
    const taskId = ((await launchRes.json()) as { id: string }).id

    // 2. Round 0 → awaiting_human after the stub's clarify envelope.
    await pollTaskStatus(daemon, taskId, (t) => t.status === 'awaiting_human', 30_000)
    const rows = await pollClarifySession(daemon, taskId, (r) => r.length >= 1, 5_000)
    expect(rows.length).toBe(1)

    // 3. Submit answers.
    const session = rows[0]!
    expectOk(
      await fetch(`${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}/answers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-db',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          // RFC-100: stop releases the designer from mandatory ask-back so its rerun outputs.
          directive: 'stop',
          ifMatchIteration: session.iteration,
        }),
      }),
      'POST inline clarify answers',
    )

    // 4. Round 1 → done.
    await pollTaskStatus(daemon, taskId, (t) => t.status === 'done', 30_000)

    // 5. Assertion A: the stub captured TWO argv lines; the second one contains
    //    `--session opc_e2e_e2e-rfc026-designer`. The first one MUST NOT.
    const log = readFileSync(argvLog, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0]).not.toContain('--session')
    const round1 = log[log.length - 1]!
    expect(round1).toContain('--session')
    expect(round1).toContain('opc_e2e_e2e-rfc026-designer')

    // 6. Assertion B: the persisted node_runs row for round 0 (RFC-074 PR-C:
    //    the earliest 'designer' run by ULID id — clarify generation 0)
    //    carries the same opencodeSessionId the stub emitted.
    const runsRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/node-runs`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expectOk(runsRes, 'GET task node-runs')
    const runsBody = (await runsRes.json()) as {
      runs: Array<{
        id: string
        nodeId: string
        opencodeSessionId: string | null
      }>
    }
    const round0Run = runsBody.runs
      .filter((r) => r.nodeId === 'designer')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
    expect(round0Run?.opencodeSessionId).toBe('opc_e2e_e2e-rfc026-designer')
  })
})

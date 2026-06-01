// Regression for "review-iterate rerun should not re-feed prior clarify Q&A".
//
// Scenario:
//   1. Designer agent has a clarify channel wired. First run asks
//      `<workflow-clarify>` ("Which database?"); user answers; the rerun
//      produces `<workflow-output>` (status=done, clarifyIteration=1). The
//      done row's captured output flows downstream — the review node enters
//      awaiting_review.
//   2. Reviewer iterates with comments.
//   3. submitReviewDecision('iterated') cancels the done designer row with a
//      `superseded-by-review-iterated*` marker AND mints a fresh pending row
//      at the same clarifyIteration=1 with retryIndex=1.
//   4. Scheduler picks up the fresh pending row and renders its prompt.
//
// Contract: the fresh row's promptText MUST NOT carry the prior clarify Q&A
// (`Which database?` / `Postgres`). Rationale (user-stated rule): once an
// agent has emitted a parseable `<workflow-output>` and downstream proceeded,
// the clarify rounds baked into that prompt are already folded into the
// captured output / opencode session memory. Re-feeding them on a later
// downstream-driven rerun wastes tokens and re-anchors the agent on
// resolved decisions.
//
// Wiring locked: scheduler.ts computes `priorCompletedTopLevelRun` as the
// freshest prior top-level node_run that has captured `node_run_outputs`
// rows. runner.ts only INSERTs into that table AFTER port-content
// validation passes (RFC-049, see runner.ts §parseEnvelope), so a row's
// existence is by itself proof that the agent produced a valid
// `<workflow-output>` envelope whose ports also passed their kind handler
// (incl. markdown_file file-exists check). Its clarifyIteration is the
// cutoff threaded into buildClarifyPromptContext, dropping sessions with
// iterationIndex < cutoff. If this goes red, check scheduler.ts around the
// `priorCompletedTopLevelRun` block + the validate-before-insert ordering
// in runner.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runTask } from '../src/services/scheduler'
import { startTask } from '../src/services/task'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  stubOpencode: string
  taskId: string
  designerDoneRunId: string
  reviewNodeRunId: string
  cleanup: () => Promise<void>
}

const DESIGN_BODY_V1 = '# Design v1\n\nPicked Postgres per the clarify round.\n'
const DESIGN_BODY_V2 = '# Design v2\n\nKept Postgres, addressed reviewer comments.\n'

let runIdx = 0

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const v1 = DESIGN_BODY_V1.replace(/\n/g, '\\n')
  const v2 = DESIGN_BODY_V2.replace(/\n/g, '\\n')
  const counterFile = join(dir, '.invoke-counter')
  writeFileSync(counterFile, '0')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then
  echo 'stub-opencode 1.14.99'
  exit 0
fi
if [[ "$1" == "run" ]]; then
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
  echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then
    BODY='${v1}'
  else
    BODY='${v2}'
  fi
  ENV='<workflow-output><port name="design">'"$BODY"'</port></workflow-output>'
  TS=$(date +%s%3N)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
  exit 0
fi
echo "unknown subcommand $1"
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

const CLARIFY_QUESTION: ClarifyQuestion = {
  id: 'q-db',
  title: 'Which database?',
  kind: 'single',
  recommended: false,
  options: [
    { label: 'Postgres', description: '', recommended: true, recommendationReason: '' },
    { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
  ],
}

const CLARIFY_ANSWER: ClarifyAnswer = {
  questionId: 'q-db',
  selectedOptionIndices: [0],
  selectedOptionLabels: ['Postgres'],
  customText: '',
}

async function buildHarness(): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rev-iter-clarify-drop-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)

  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' })
  execSync(`mkdir -p "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, {
    stdio: 'ignore',
  })

  const stubOpencode = makeStubOpencode(tmp)

  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  const wf = await createWorkflow(db, {
    name: 'design-with-clarify-and-review',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        {
          id: 'designer',
          kind: 'agent-single',
          agentName: 'designer',
          promptTemplate: 'Design for {{topic}}',
        },
        { id: 'clarify1', kind: 'clarify', title: 'Clarify' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clarify1', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clarify1', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
      ],
    },
  })

  process.env.AGENT_WORKFLOW_HOME = appHome

  const task = await startTask(
    {
      workflowId: wf.id,
      name: 'fixture-task',
      repoPath,
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    },
    { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
  )

  // After startTask the stub responds workflow-output → designer is `done`
  // and rev_1 is `awaiting_review`. Locate both rows so the test can stage
  // the clarify Q&A retroactively (simpler than building a multi-step stub
  // that produces workflow-clarify on the first call). The clarify session
  // is anchored on the (currently done) designer run and bumps its
  // clarifyIteration to 1 — semantically: "this done was the post-clarify
  // rerun".
  const designerRows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'designer')))
  const designerDone = designerRows.find((r) => r.status === 'done' && r.parentNodeRunId === null)
  if (designerDone === undefined) throw new Error('designer done row not found')
  const reviewRows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'rev_1')))
  if (reviewRows.length === 0) throw new Error('rev_1 node_run not created')

  // Synthetic prior-round source row at clarifyIteration=0 (the run that
  // would have emitted `<workflow-clarify>` in a real flow). createClarifySession
  // looks up sourceAgentNodeRunId to pull display info; the row need only exist.
  // RFC-074 PR-C: freshness is pure ULID id-order. This canceled "asking" row
  // is the OLDER generation (superseded by the post-clarify done row), so it
  // must carry a SMALLER id than designerDone (which startTask minted as a real
  // ULID). An explicit `0000…` id sorts before any 2026-era ULID.
  const priorAskingRunId = '0000_prior_asking_designer'
  await db.insert(nodeRuns).values({
    id: priorAskingRunId,
    taskId: task.id,
    nodeId: 'designer',
    status: 'canceled', // would be replaced by the clarify-rerun row in real flow
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 4500,
    errorMessage: 'clarify-rerun-superseded',
  })

  await createClarifySession({
    db,
    taskId: task.id,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: priorAskingRunId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: 0,
    questions: [CLARIFY_QUESTION],
  })
  // Find the clarify session's clarifyNodeRunId so we can answer it.
  const { clarifySessions } = await import('../src/db/schema')
  const sessionRows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.taskId, task.id))
  const clarifyNodeRunId = sessionRows[0]?.clarifyNodeRunId
  if (clarifyNodeRunId === undefined) throw new Error('clarify session not created')

  // Answering normally would mint a fresh source-agent rerun row at cli=1.
  // We immediately remove that auto-minted row (the existing `done` row from
  // startTask is acting as the "post-clarify rerun done" stand-in) and bump
  // the done row's clarifyIteration to 1 so the cutoff logic sees it as
  // "this node previously completed an output cycle AFTER session iterIdx=0".
  const answerResult = await submitClarifyAnswers({
    db,
    clarifyNodeRunId,
    answers: [CLARIFY_ANSWER],
  })
  await db.delete(nodeRuns).where(eq(nodeRuns.id, answerResult.rerunNodeRunId))
  // RFC-070: under the consumed-by-run aging model, the post-clarify done
  // designer run (designerDone) is also the consumer that baked the answered
  // round into its `<workflow-output>`. In real flow runner.ts stamps this
  // automatically (services/runner.ts mark gate); the test bypasses runner
  // for the seeded round so we mirror the stamp here. Without this, the
  // round would be NULL-consumed and the IS NULL filter would surface it
  // again on the iterate rerun — the exact regression this test prevents
  // for the iteration-cutoff era is now governed by the consumed stamp.
  const { clarifyRounds: cr2, clarifySessions: cs2 } = await import('../src/db/schema')
  await db
    .update(cr2)
    .set({ consumedByConsumerRunId: designerDone.id })
    .where(eq(cr2.taskId, task.id))
  await db
    .update(cs2)
    .set({ consumedByConsumerRunId: designerDone.id })
    .where(eq(cs2.taskId, task.id))

  return {
    db,
    appHome,
    stubOpencode,
    taskId: task.id,
    designerDoneRunId: designerDone.id,
    reviewNodeRunId: reviewRows[0]!.id,
    cleanup: async () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.AGENT_WORKFLOW_HOME
    },
  }
}

describe('review-iterate rerun drops prior clarify Q&A from the prompt', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('iterate cancels the post-clarify done row; the fresh designer prompt does NOT contain the answered clarify Q&A', async () => {
    const COMMENT = 'tighten the connection pool wording'

    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Design v1',
        paragraphIdx: 1,
        offsetStart: 0,
        offsetEnd: 15,
        selectedText: 'Picked Postgres',
        contextBefore: '',
        contextAfter: ' per the',
        occurrenceIndex: 1,
      },
      commentText: COMMENT,
    })

    const result = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    expect(result.resumeRequired).toBe(true)

    // The post-clarify done row should now be a canceled superseded row.
    const supersededRow = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.designerDoneRunId))
    )[0]
    expect(supersededRow?.status).toBe('canceled')
    expect(supersededRow?.errorMessage ?? '').toContain('superseded-by-review-iterated')
    // Its clarifyIteration must still read 1 — the cutoff is read off this row.

    await runTask({
      taskId: h.taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: [h.stubOpencode],
    })

    const designerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'designer')))
    const tops = designerRuns
      .filter((r) => r.parentNodeRunId === null && r.id !== h.designerDoneRunId)
      .filter((r) => r.retryIndex >= 1)
    expect(tops.length).toBeGreaterThanOrEqual(1)
    const fresh = tops.sort((a, b) => b.retryIndex - a.retryIndex)[0]!
    expect(fresh.promptText).not.toBeNull()
    const prompt = fresh.promptText!

    // CORE assertion: the prior clarify Q&A is dropped.
    //   - `Which database?` was the question text rendered into questionsBlock.
    //   - `### Round 1` is the round-header buildClarifyPromptContext emits;
    //     unlike "Prior Rounds (Answers)" it has no quoted-reference twin in
    //     the bi-modal protocol block, so its absence proves the clarify
    //     sections were skipped entirely (cc===undefined → no auto-append).
    expect(prompt).not.toContain('Which database?')
    expect(prompt).not.toContain('### Round 1')

    // Sanity: the review iterate path is still wiring its own context — the
    // user's comment surfaces. (Locks the "we dropped clarify but kept
    // review-iterate" pairing — accidentally tipping the cutoff into review
    // context would silently regress this test.)
    expect(prompt).toContain(COMMENT)
    expect(prompt).toContain('## Review Comments')
  })
})

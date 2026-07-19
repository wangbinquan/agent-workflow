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

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runTask as runTaskBase } from '../src/services/scheduler'
import {
  abortAllActiveTasks,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
import { runTestGit } from './helpers/testCommand'
import { reenterScheduler } from './reenter-scheduler'
import { DEFAULT_PROTOCOL_RETRY_BUDGET, type ClarifyAnswer } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000

setDefaultTimeout(FLOW_TIMEOUT_MS + 10_000)

async function git(...args: string[]): Promise<void> {
  await runTestGit(args, GIT_TIMEOUT_MS)
}

function runTask(options: Parameters<typeof runTaskBase>[0]) {
  return runTaskBase({
    ...options,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

function startTaskWithLocalRepo(
  input: Parameters<typeof startTaskWithLocalRepoBase>[0],
  deps: Parameters<typeof startTaskWithLocalRepoBase>[1],
) {
  return startTaskWithLocalRepoBase(input, {
    ...deps,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

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
  NONCE=$(printf '%s' "$2" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OUTPUT_OPEN='<workflow-output>'; CLARIFY_OPEN='<workflow-clarify>'
  if [[ -n "$NONCE" ]]; then
    OUTPUT_OPEN='<workflow-output nonce="'"$NONCE"'">'
    CLARIFY_OPEN='<workflow-clarify nonce="'"$NONCE"'">'
  fi
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
  echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then
    # RFC-100: clarify channel ⇒ mandatory ask-back on the designer's first reply.
    ENV="$CLARIFY_OPEN"'{"questions":[{"id":"q-db","title":"Which database?","kind":"single","options":["Postgres","MySQL"]}]}</workflow-clarify>'
  elif [[ $N -eq 2 ]]; then
    BODY='${v1}'
    ENV="$OUTPUT_OPEN"'<port name="design">'"$BODY"'</port></workflow-output>'
  else
    BODY='${v2}'
    ENV="$OUTPUT_OPEN"'<port name="design">'"$BODY"'</port></workflow-output>'
  fi
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
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME

  await git('-C', tmp, 'init', '-b', 'main')
  mkdirSync(repoPath, { recursive: true })
  await git('-C', repoPath, 'init', '-b', 'main')
  await git('-C', repoPath, 'config', 'user.email', 't@t.test')
  await git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await git('-C', repoPath, 'add', '.')
  await git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')

  const stubOpencode = makeStubOpencode(tmp)

  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
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

  const task = await startTaskWithLocalRepo(
    {
      workflowId: wf.id,
      name: 'fixture-task',
      repoPath,
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    },
    { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
  )

  // RFC-100: the designer has a clarify channel, so its FIRST reply is a
  // mandatory `<workflow-clarify>` (stub call 1) → awaiting_human. Answer with
  // stop → the rerun (stub call 2) produces output v1 → designer `done`, rev_1
  // awaiting_review. The runner stamps the answered clarify round
  // consumed_by_consumer_run_id = the v1 output run (RFC-070, runner.ts mark
  // gate) — exactly the state this test needs (a prior ANSWERED, CONSUMED clarify
  // round), now via the real flow instead of retroactive staging + manual stamp.
  const { clarifySessions } = await import('../src/db/schema')
  const sessionRows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.taskId, task.id))
  const clarifyNodeRunId = sessionRows[0]?.clarifyNodeRunId
  if (clarifyNodeRunId === undefined) throw new Error('clarify session not created on first run')
  await autoDispatchClarifyRound({
    db,
    originNodeRunId: clarifyNodeRunId,
    answers: [CLARIFY_ANSWER],
    directive: 'stop', // finalize → the designer outputs v1
    actor: { userId: 'u1', role: 'owner' },
  })
  await reenterScheduler(db, task.id)
  await runTask({ taskId: task.id, db, appHome, opencodeCmd: [stubOpencode] })

  const designerRows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'designer')))
  // The designer now has TWO done top-level rows: the clarify run (stub call 1)
  // and the v1 OUTPUT run (stub call 2, after the stop answer). The review
  // consumes the output run, so pick the latest (ULID id-order) done row.
  const designerDone = designerRows
    .filter((r) => r.status === 'done' && r.parentNodeRunId === null)
    .sort((a, b) => (a.id > b.id ? -1 : 1))[0]
  if (designerDone === undefined) throw new Error('designer done row not found')
  const reviewRows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'rev_1')))
  if (reviewRows.length === 0) throw new Error('rev_1 node_run not created')

  return {
    db,
    appHome,
    stubOpencode,
    taskId: task.id,
    designerDoneRunId: designerDone.id,
    reviewNodeRunId: reviewRows[0]!.id,
    cleanup: async () => {
      try {
        db.$client.close()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
        else process.env.AGENT_WORKFLOW_HOME = previousAppHome
      }
    },
  }
}

describe('review-iterate rerun drops prior clarify Q&A from the prompt', () => {
  let h: Harness
  let cleanupHarness: (() => Promise<void>) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  beforeEach(async () => {
    cleanupHarness = undefined
    watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
    h = await buildHarness()
    cleanupHarness = h.cleanup
  })
  afterEach(async () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    abortAllActiveTasks('test-cleanup')
    await cleanupHarness?.()
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

    // RFC-097: runTask's entry CAS only claims pending tasks — reset first
    // (test stand-in for resumeTask).
    await reenterScheduler(h.db, h.taskId)
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

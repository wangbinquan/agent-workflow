// Regression for "markdown 提了检视意见以后，检视意见没有进入迭代提示词"
// (review comments left on a markdown doc never made it into the iterate
// re-run prompt). Wiring chain at the time of the bug:
//
//   submitReviewDecision        ✓ rendered comments into doc_versions.decisionReason
//   buildReviewPromptContext    ✓ returned { comments, iterateTargetPort }
//   renderUserPrompt            ✓ substituted {{__review_comments__}} when given
//                                 reviewContext + auto-appended ## Review Comments
//   ── runner.ts:renderUserPrompt call  ✗ never received reviewContext
//   ── scheduler.ts before runNode      ✗ never called buildReviewPromptContext
//
// As a result the upstream agent's regenerated prompt was identical to the
// first run — the user's comments were silently dropped on the floor. This
// test pins the end-to-end path: add comment → iterate → resume scheduler →
// the freshly-minted designer node_run's promptText contains the comment.
//
// If this goes red, check:
//   packages/backend/src/services/runner.ts (RunNodeOptions.reviewContext +
//     pass-through to renderUserPrompt), and
//   packages/backend/src/services/scheduler.ts (buildReviewPromptContext
//     call before runNode in BOTH the agent-single and agent-multi paths).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runTask as runTaskBase } from '../src/services/scheduler'
import {
  abortAllActiveTasks,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
import { runTestGit } from './helpers/testCommand'
import { reenterScheduler } from './reenter-scheduler'

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
  reviewNodeRunId: string
  cleanup: () => Promise<void>
}

const REVIEW_DOC_V1 = '# Design v1\n\nThe `order_status` enum should include partially_refunded.\n'
const REVIEW_DOC_V2 =
  '# Design v2\n\nThe `order_status` enum now includes pending_payment + partially_refunded.\n'

let runIdx = 0

function makeStubOpencode(dir: string): string {
  // First call → v1 markdown; later calls → v2. Same shape as the
  // review-state-machine harness (kept independent so this regression can be
  // run + understood in isolation).
  const path = join(dir, 'stub-opencode.sh')
  const v1 = REVIEW_DOC_V1.replace(/\n/g, '\\n')
  const v2 = REVIEW_DOC_V2.replace(/\n/g, '\\n')
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
  OPEN='<workflow-output>'; if [[ -n "$NONCE" ]]; then OPEN='<workflow-output nonce="'"$NONCE"'">'; fi
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
  echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then
    BODY='${v1}'
  else
    BODY='${v2}'
  fi
  ENV="$OPEN"'<port name="design">'"$BODY"'</port></workflow-output>'
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

async function buildHarness(): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-review-iter-prompt-${runIdx}-`))
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
    name: 'design-pipeline',
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
          // Note: template intentionally does NOT reference
          // {{__review_comments__}} explicitly — we want to assert that the
          // framework auto-appends the `## Review Comments` section on the
          // re-run, since that's the contract author-written prompts depend
          // on (RFC-005 design.md §7).
          promptTemplate: 'Design for {{topic}}',
        },
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

  const reviewRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'rev_1')))
  if (reviewRuns.length === 0) throw new Error('rev_1 node_run not created')

  return {
    db,
    appHome,
    stubOpencode,
    taskId: task.id,
    reviewNodeRunId: reviewRuns[0]!.id,
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

describe('RFC-005 review iterate — comments reach the upstream re-run prompt', () => {
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

  test('comment + iterate + resume scheduler → new designer prompt contains the comment text', async () => {
    const COMMENT = 'include pending_payment in the enum'

    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Design v1',
        paragraphIdx: 1,
        offsetStart: 4,
        offsetEnd: 16,
        selectedText: 'order_status',
        contextBefore: 'The `',
        contextAfter: '` enum should',
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

    // Re-enter the scheduler synchronously (mirrors what resumeTask kicks
    // off async-style in production).
    // RFC-097: runTask's entry CAS only claims pending tasks — reset first.
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
      .filter((r) => r.parentNodeRunId === null)
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(tops.length).toBe(2)
    const fresh = tops[1]!
    // The fresh run's prompt should be persisted to node_runs.promptText
    // before the runner spawns opencode (runner.ts:124).
    expect(fresh.promptText).not.toBeNull()
    const prompt = fresh.promptText!

    // The literal user comment text must appear in the prompt — that's the
    // user-visible contract this regression locks in.
    expect(prompt).toContain(COMMENT)
    // ...rendered under the framework's auto-appended section header (the
    // node template did not reference {{__review_comments__}} explicitly).
    expect(prompt).toContain('## Review Comments')
    // ...with the breadcrumb + selection metadata renderCommentsForPrompt
    // emits — proves we're going through the structured renderer, not just
    // dumping the raw decision reason.
    expect(prompt).toContain('order_status')
    expect(prompt).toContain('Comment 1')
  })
})

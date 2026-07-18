// RFC-119 END-TO-END verification — prior-output injection in a REAL task.
//
// Unlike the unit tests (which exercise freshestPriorRunWithOutput /
// composePriorOutputBlock / renderUserPrompt in isolation), this drives the
// FULL scheduler `runTask` through a real review-iterate rerun with a stub
// opencode binary, and asserts the prompt the re-run agent ACTUALLY receives
// carries the prior output + the neutral update-or-regenerate directive.
//
// Flow:
//   1. workflow: input → auditor(outputs:[report]) → review.
//   2. runTask → auditor's first opencode call emits report = V1 (with a unique
//      marker); review enters awaiting_review.
//   3. reviewer iterates with a comment → submitReviewDecision('iterated')
//      supersedes the auditor's done row (canceled, output rows kept) + mints a
//      fresh pending row (retryIndex=1).
//   4. runTask re-runs the auditor.
//   5. CORE: the fresh row's promptText contains
//      `## Prior Output (to update or regenerate)` + the V1 marker + the neutral
//      `## Update Directive` — i.e. the agent is told "here's what you produced;
//      update or regenerate it" with the actual prior body inlined.
//
// If this goes red, RFC-119's scheduler wiring (freshestPriorRunWithOutput →
// composePriorOutputBlock → priorOutputUpdate → renderUserPrompt) regressed on
// the real review-iterate path.
//
// RFC-141 (ask-back rounds now inject the draft too) has NO runTask-level case
// here: driving "node produced output, then re-enters mandatory ask-back"
// end-to-end needs a multi-round clarify harness (answer → re-open directive →
// retry) this stub setup doesn't have. Coverage is layered instead:
//   - variant render: shared/tests/rerun-prior-output.test.ts (ask-back pair,
//     golden lock, placement);
//   - composePriorOutputBlock → renderUserPrompt shape:
//     rerun-prior-output-injection.test.ts (RFC-141 ask-back case);
//   - scheduler gate: rerun-prior-output-source-guards.test.ts negative locks
//     (!effectiveHasClarifyChannel / !suppressPriorOutput must stay gone), and
//     the hasClarifyChannel threading is locked by clarify-prompt-wire-up.test.ts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
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
import { nonInteractiveGitEnv } from '../src/util/git'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000

setDefaultTimeout(FLOW_TIMEOUT_MS + 10_000)

function git(...args: string[]): void {
  execFileSync('git', args, {
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS,
    env: nonInteractiveGitEnv(),
  })
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

const V1_MARKER = 'PRIOR-AUDIT-MARKER-V1'
const REPORT_V1 = `# Audit Report v1\n\nFINDING: ${V1_MARKER} — the login handler lacks rate limiting.\n`
const REPORT_V2 = '# Audit Report v2\n\nAddressed the reviewer comment.\n'

interface Harness {
  db: DbClient
  appHome: string
  stubOpencode: string
  taskId: string
  auditorDoneRunId: string
  reviewNodeRunId: string
  cleanup: () => void
}

let runIdx = 0

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const v1 = REPORT_V1.replace(/\n/g, '\\n')
  const v2 = REPORT_V2.replace(/\n/g, '\\n')
  const counterFile = join(dir, '.invoke-counter')
  writeFileSync(counterFile, '0')
  // First auditor call → V1; every later call (the rerun) → V2. The review node
  // is not an agent, so it does not bump the counter.
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE"); N=$((N + 1)); echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then BODY='${v1}'; else BODY='${v2}'; fi
  ENV='<workflow-output><port name="report">'"$BODY"'</port></workflow-output>'
  TS=$(date +%s%3N)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
  exit 0
fi
echo "unknown subcommand $1"; exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

async function buildHarness(): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc119-e2e-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME

  mkdirSync(repoPath, { recursive: true })
  git('-C', repoPath, 'init', '-b', 'main')
  git('-C', repoPath, 'config', 'user.email', 't@t.test')
  git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  git('-C', repoPath, 'add', '.')
  git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')

  const stubOpencode = makeStubOpencode(tmp)

  await createAgent(db, {
    name: 'auditor',
    description: '',
    outputs: ['report'],
    outputKinds: { report: 'markdown' },
    syncOutputsOnIterate: false,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  const wf = await createWorkflow(db, {
    name: 'audit-with-review',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        {
          id: 'auditor',
          kind: 'agent-single',
          agentName: 'auditor',
          promptTemplate: 'Audit {{topic}}',
        },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'auditor', portName: 'report' },
          rerunnableOnIterate: ['auditor'],
          rerunnableOnReject: ['auditor'],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'auditor', portName: 'topic' },
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

  const auditorRows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'auditor')))
  const auditorDone = auditorRows
    .filter((r) => r.status === 'done' && r.parentNodeRunId === null)
    .sort((a, b) => (a.id > b.id ? -1 : 1))[0]
  if (auditorDone === undefined) throw new Error('auditor done row not found')
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
    auditorDoneRunId: auditorDone.id,
    reviewNodeRunId: reviewRows[0]!.id,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true })
      if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousAppHome
    },
  }
}

describe('RFC-119 e2e — review-iterate rerun gets the prior output in its prompt', () => {
  let h: Harness
  let cleanupHarness: (() => void) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  beforeEach(async () => {
    cleanupHarness = undefined
    watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
    h = await buildHarness()
    cleanupHarness = h.cleanup
  })
  afterEach(() => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    abortAllActiveTasks('test-cleanup')
    cleanupHarness?.()
  })

  test('the fresh auditor prompt carries `## Prior Output` + the V1 body + the update directive', async () => {
    const COMMENT = 'add a concrete remediation for the rate-limit finding'

    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Audit Report v1',
        paragraphIdx: 1,
        offsetStart: 0,
        offsetEnd: 7,
        selectedText: 'FINDING',
        contextBefore: '',
        contextAfter: ': ',
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

    // The original done row is now a canceled supersede marker — but its
    // node_run_outputs row (report=V1) is kept, which is what RFC-119 reads.
    const superseded = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.auditorDoneRunId))
    )[0]
    expect(superseded?.status).toBe('canceled')

    // Re-run the auditor (RFC-097: reset the terminal task so runTask's CAS claims it).
    await reenterScheduler(h.db, h.taskId)
    await runTask({
      taskId: h.taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: [h.stubOpencode],
    })

    const fresh = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'auditor')))
    )
      .filter((r) => r.parentNodeRunId === null && r.id !== h.auditorDoneRunId && r.retryIndex >= 1)
      .sort((a, b) => b.retryIndex - a.retryIndex)[0]
    expect(fresh?.promptText).toBeTruthy()
    const prompt = fresh!.promptText!

    // CORE RFC-119 assertions — the re-run agent's REAL prompt.
    expect(prompt).toContain('## Prior Output (to update or regenerate)')
    expect(prompt).toContain(V1_MARKER) // the actual prior output body is inlined
    expect(prompt).toContain('## Update Directive')
    // neutral directive: offers update AND regenerate, demands the COMPLETE output.
    expect(prompt.toLowerCase()).toContain('regenerate')
    expect(prompt.toLowerCase()).toContain('complete')
    expect(prompt.toLowerCase()).not.toContain('do not regenerate')

    // Sanity: the review-iterate context is still wired (the comment surfaces),
    // so prior-output rides ALONGSIDE the feedback, not instead of it.
    expect(prompt).toContain('## Review Comments')
    expect(prompt).toContain(COMMENT)
  })
})

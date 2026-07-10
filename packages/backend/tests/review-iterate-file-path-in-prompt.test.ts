// Regression for the file-path follow-up to "review comments in iterate
// prompt": when the upstream port is `markdown_file`, the rendered
// comments block in the iterate re-run prompt must include a
// `**File**: \`<worktree-relative path>\`` header so the agent knows which
// file to modify. Without it, the agent saw the user's comments but had no
// reliable pointer to the underlying document (the port's value had been
// resolved to body text by the time the prompt was assembled).
//
// Wiring locked here:
//   dispatchReviewNode → resolvePortContentDetailed → captures sourcePath
//     → createDocVersion writes doc_versions.source_file_path
//     → submitReviewDecision passes it to renderCommentsForPrompt
//     → buildReviewPromptContext returns it via decisionReason
//     → scheduler/runner inject it into the upstream re-run prompt.
//
// If this goes red, see services/envelope.ts (resolvePortContentDetailed),
// services/review.ts (createDocVersion + renderCommentsForPrompt +
// submitReviewDecision), and the doc_versions schema migration that adds
// the source_file_path column.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runTask } from '../src/services/scheduler'
import { startTaskWithLocalRepo } from '../src/services/task'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  stubOpencode: string
  taskId: string
  reviewNodeRunId: string
  sourcePath: string
  cleanup: () => Promise<void>
}

const SOURCE_PATH = 'design/software_design.md'
const REVIEW_DOC_V1 = '# Software Design v1\n\nThe `order_status` enum needs partially_refunded.\n'
const REVIEW_DOC_V2 = '# Software Design v2\n\nThe `order_status` enum now includes pending.\n'

let runIdx = 0

// Stub-opencode that, on each `run`, writes the design body into the task
// worktree (cwd) at SOURCE_PATH and emits an envelope whose `design` port
// content is the relative path — i.e. the markdown_file kind contract.
function makeStubOpencode(dir: string): string {
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
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
  echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then
    BODY='${v1}'
  else
    BODY='${v2}'
  fi
  mkdir -p "$(dirname "${SOURCE_PATH}")"
  printf '%b' "$BODY" > '${SOURCE_PATH}'
  ENV='<workflow-output><port name="design">${SOURCE_PATH}</port></workflow-output>'
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
  const tmp = mkdtempSync(join(tmpdir(), `aw-rev-iter-fpath-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)

  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' })
  execSync(`mkdir -p "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, { stdio: 'ignore' })

  const stubOpencode = makeStubOpencode(tmp)

  // Designer agent emitting `markdown_file` kind on `design` — the strict
  // branch in resolvePortContentDetailed will read the file and report its
  // path, which is what dispatchReviewNode snapshots.
  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown_file' },
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
          // No explicit {{__review_comments__}} reference — assert that the
          // framework auto-appends ## Review Comments AND the **File**:
          // header inside it.
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
    sourcePath: SOURCE_PATH,
    cleanup: async () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.AGENT_WORKFLOW_HOME
    },
  }
}

describe('RFC-005 followup — markdown_file source path lands in iterate prompt', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('dispatch captures source_file_path on doc_versions', async () => {
    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dvs.length).toBe(1)
    expect(dvs[0]?.sourceFilePath).toBe(h.sourcePath)
  })

  test('iterate decisionReason embeds **File**: header above comments', async () => {
    const COMMENT = 'include pending_payment in the enum'
    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Software Design v1',
        paragraphIdx: 1,
        offsetStart: 4,
        offsetEnd: 16,
        selectedText: 'order_status',
        contextBefore: 'The `',
        contextAfter: '` enum needs',
        occurrenceIndex: 1,
      },
      commentText: COMMENT,
    })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dvs[0]?.decision).toBe('iterated')
    const reason = dvs[0]!.decisionReason ?? ''
    expect(reason).toContain(`**File**: \`${h.sourcePath}\``)
    expect(reason).toContain('### Comment 1')
    expect(reason).toContain(COMMENT)
    // Header must precede the comment block.
    expect(reason.indexOf('**File**:')).toBeLessThan(reason.indexOf('### Comment 1'))
  })

  test('after resume scheduler, fresh designer prompt contains **File**: header', async () => {
    const COMMENT = 'rename order_status to checkout_status'
    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Software Design v1',
        paragraphIdx: 1,
        offsetStart: 4,
        offsetEnd: 16,
        selectedText: 'order_status',
        contextBefore: 'The `',
        contextAfter: '` enum needs',
        occurrenceIndex: 1,
      },
      commentText: COMMENT,
    })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
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
      .filter((r) => r.parentNodeRunId === null)
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(tops.length).toBe(2)
    const fresh = tops[1]!
    expect(fresh.promptText).not.toBeNull()
    const prompt = fresh.promptText!

    expect(prompt).toContain('## Review Comments')
    expect(prompt).toContain(`**File**: \`${h.sourcePath}\``)
    expect(prompt).toContain(COMMENT)
    expect(prompt).toContain('Comment 1')
    // Header lands inside the auto-appended ## Review Comments section.
    expect(prompt.indexOf('## Review Comments')).toBeLessThan(prompt.indexOf('**File**:'))
  })
})

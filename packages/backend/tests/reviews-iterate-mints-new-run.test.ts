// Locks in RFC-011 backend semantics: review reject / iterate must not
// reset the latest upstream node_run in place. Instead it marks the old
// row canceled (with a stable supersede prefix on errorMessage) and mints
// a fresh node_run at retry_index+1 inheriting preSnapshot. This preserves
// the old row's promptText / outputs so the Prompt-tab attempts switcher
// (RFC-011 T2) can render historical prompts.
//
// If this goes red, services/review.ts:submitReviewDecision iterate/reject
// branch is out of lock-step with RFC-011 design §3.1.

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
import { submitReviewDecision } from '../src/services/review'
import { startTask } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  taskId: string
  reviewNodeRunId: string
  cleanup: () => Promise<void>
}

const REVIEW_DOC = '# Design v1\n\nThe `order_status` enum should include partially_refunded.\n'

let runIdx = 0

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const body = REVIEW_DOC.replace(/\n/g, '\\n')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then
  echo 'stub-opencode 1.14.99'
  exit 0
fi
if [[ "$1" == "run" ]]; then
  BODY='${body}'
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

async function buildHarness(opts?: { secondReviewNode?: boolean }): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc011-${runIdx}-`))
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

  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: false,
    permission: {},
    skills: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  // Use loose typing — the workflow schema accepts unknown extras and the
  // reviewer fields aren't part of WorkflowNodeSchema's strict shape.
  const reviewNodes = [
    {
      id: 'rev_1',
      kind: 'review' as const,
      inputSource: { nodeId: 'designer', portName: 'design' },
      rerunnableOnReject: ['designer'],
      rerunnableOnIterate: ['designer'],
    },
  ]
  if (opts?.secondReviewNode === true) {
    reviewNodes.push({
      id: 'rev_2',
      kind: 'review' as const,
      inputSource: { nodeId: 'designer', portName: 'design' },
      rerunnableOnReject: ['designer'],
      rerunnableOnIterate: ['designer'],
    })
  }

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
          promptTemplate: 'Design for {{topic}}',
        },
        ...reviewNodes,
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

  const task = await startTask(
    { workflowId: wf.id, repoPath, baseBranch: 'main', inputs: { topic: 'orders' } },
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
    taskId: task.id,
    reviewNodeRunId: reviewRuns[0]!.id,
    cleanup: async () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.AGENT_WORKFLOW_HOME
    },
  }
}

async function fetchDesignerTopRuns(h: Harness) {
  const rows = await h.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'designer')))
  return rows.filter((r) => r.parentNodeRunId === null).sort((a, b) => a.retryIndex - b.retryIndex)
}

describe('RFC-011 review reject/iterate mints a fresh node_run', () => {
  let h: Harness
  afterEach(async () => {
    await h.cleanup()
  })

  test('iterate keeps the old upstream run as canceled and preserves its promptText', async () => {
    h = await buildHarness()
    const beforeRuns = await fetchDesignerTopRuns(h)
    expect(beforeRuns.length).toBe(1)
    const originalPrompt = beforeRuns[0]!.promptText
    expect(originalPrompt).not.toBeNull()

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const afterRuns = await fetchDesignerTopRuns(h)
    expect(afterRuns.length).toBe(2)
    const old = afterRuns[0]!
    expect(old.retryIndex).toBe(0)
    expect(old.status).toBe('canceled')
    expect(old.promptText).toBe(originalPrompt) // not overwritten
    expect(old.errorMessage).toContain('superseded-by-review-iterated')
    expect(old.finishedAt).not.toBeNull()
  })

  test('iterate mints a new pending row at retry_index+1 inheriting preSnapshot', async () => {
    h = await buildHarness()
    const before = (await fetchDesignerTopRuns(h))[0]!
    const beforeSnapshot = before.preSnapshot

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const afterRuns = await fetchDesignerTopRuns(h)
    const fresh = afterRuns.find((r) => r.retryIndex === 1)
    expect(fresh).toBeDefined()
    expect(fresh!.status).toBe('pending')
    expect(fresh!.preSnapshot).toBe(beforeSnapshot)
    expect(fresh!.parentNodeRunId).toBeNull()
    expect(fresh!.iteration).toBe(before.iteration)
    // The fresh row is the one the scheduler will pick up next; its
    // promptText starts blank until runner.ts:127 writes the new prompt.
    expect(fresh!.promptText).toBeNull()
  })

  test('reject does the same and sibling review nodes still cascade back to awaiting_review', async () => {
    h = await buildHarness({ secondReviewNode: true })
    const before = await fetchDesignerTopRuns(h)
    expect(before.length).toBe(1)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    expect(after.length).toBe(2)
    expect(after[0]!.status).toBe('canceled')
    expect(after[0]!.errorMessage).toContain('superseded-by-review-rejected')
    expect(after[1]!.status).toBe('pending')
    expect(after[1]!.retryIndex).toBe(1)

    // Sibling review row (rev_2) should be reset back to awaiting_review by
    // cascadeSiblingReviews so the upstream re-run invalidates its content.
    const rev2 = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_2')))
    expect(rev2.length).toBeGreaterThan(0)
    // Sibling that was awaiting_review or done is bumped to awaiting_review
    // by cascadeSiblingReviews. Either way it should not stay 'done'.
    for (const r of rev2) {
      expect(r.status).not.toBe('done')
    }
  })
})

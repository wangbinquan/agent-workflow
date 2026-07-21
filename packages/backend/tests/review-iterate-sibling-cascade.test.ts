// RFC-014 §2.1 #1 + #3 + C1 — multi-markdown upstream + iterate path locks.
//
// Reverses the RFC-005 §2.1 #8 "single-port partial merge" behavior for any
// upstream agent that:
//   (a) declares ≥ 2 markdown[_file] outputs, AND
//   (b) has `syncOutputsOnIterate: true` (default).
//
// On the iterate decision against ONE of those ports, the framework must:
//   1. cascade every sibling review node (other markdown ports of the same
//      upstream) back to awaiting_review with a bumped reviewIteration;
//      even already-approved siblings get pulled back. This invalidates
//      their old approval — locked here.
//   2. populate `{{__sibling_outputs__}}` (the actual rendering is covered by
//      review-prompt-injection.test.ts RFC-014 cases; here we exercise the
//      cascade pathway end-to-end, including the buildSiblingOutputsBlock
//      pure function via buildReviewPromptContext).
//   3. the agent-level `syncOutputsOnIterate: false` opt-out (C5) is also
//      locked here — same workflow but agent toggles off → no cascade.
//
// If this goes red:
//   - check services/review.ts:iterateSiblingCascadeApplies (the double
//     guard agent.syncOutputsOnIterate && isMultiMarkdownUpstream(...).trigger)
//   - check the cascadeSiblingReviews call in submitReviewDecision iterate branch
//   - check buildSiblingOutputsBlock for the `__sibling_outputs__` payload

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq, desc } from 'drizzle-orm'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import {
  buildReviewPromptContext,
  buildSiblingOutputsBlock,
  submitReviewDecision,
} from '../src/services/review'
import {
  abortAllActiveTasks,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
import { runTestGit } from './helpers/testCommand'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000

setDefaultTimeout(FLOW_TIMEOUT_MS + 10_000)

async function git(...args: string[]): Promise<void> {
  await runTestGit(args, GIT_TIMEOUT_MS)
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

const PROPOSAL_DOC = '# Proposal v1\n\nWe build B2B platform for orders.\n'
const DESIGN_DOC = '# Design v1\n\nAPI exposes /orders/cancel.\n'
const PLAN_DOC = '# Plan v1\n\nWeek 1: scaffolding.\n'

let runIdx = 0

/**
 * Stub opencode that emits all three markdown ports in one envelope. Same
 * payload every call; the test cares about cascade state, not body contents.
 */
function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const escape = (s: string) => s.replace(/\n/g, '\\n')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then
  echo 'stub-opencode 1.14.99'
  exit 0
fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s' "$*" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  ENV='<workflow-output>'; if [[ -n "$NONCE" ]]; then ENV='<workflow-output nonce="'"$NONCE"'">'; fi
  ENV="$ENV"'<port name="proposal">${escape(PROPOSAL_DOC)}</port>'
  ENV="$ENV"'<port name="design">${escape(DESIGN_DOC)}</port>'
  ENV="$ENV"'<port name="plan">${escape(PLAN_DOC)}</port>'
  ENV="$ENV"'</workflow-output>'
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

interface Harness {
  db: DbClient
  appHome: string
  taskId: string
  worktreePath: string
  reviewNodeRunIds: { proposal: string; design: string; plan: string }
  cleanup: () => Promise<void>
}

interface HarnessOpts {
  agentSyncOutputsOnIterate: boolean
}

async function buildHarness(opts: HarnessOpts): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc014-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME

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
    outputs: ['proposal', 'design', 'plan'],
    outputKinds: { proposal: 'markdown', design: 'markdown', plan: 'markdown' },
    syncOutputsOnIterate: opts.agentSyncOutputsOnIterate,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  const wf = await createWorkflow(db, {
    name: 'multi-doc-design',
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
          promptTemplate: 'Write proposal/design/plan for {{topic}}',
        },
        {
          id: 'rev_proposal',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'proposal' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        {
          id: 'rev_design',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        {
          id: 'rev_plan',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'plan' },
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

  const idFor = async (nodeId: string): Promise<string> => {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, nodeId)))
    const row = rows.find((r) => r.parentNodeRunId === null) ?? rows[0]
    if (row === undefined) throw new Error(`no node_run for ${nodeId}`)
    return row.id
  }

  return {
    db,
    appHome,
    taskId: task.id,
    worktreePath: task.worktreePath,
    reviewNodeRunIds: {
      proposal: await idFor('rev_proposal'),
      design: await idFor('rev_design'),
      plan: await idFor('rev_plan'),
    },
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

describe('RFC-014 — iterate sibling cascade (multi-markdown upstream)', () => {
  let h: Harness
  let cleanupHarness: (() => Promise<void>) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  beforeEach(() => {
    cleanupHarness = undefined
    watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
  })
  afterEach(async () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    abortAllActiveTasks('test-cleanup')
    await cleanupHarness?.()
  })

  test('iterate on `design` resets sibling review nodes (`proposal` + `plan`) to awaiting_review with bumped reviewIteration', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // All three review node_runs land in awaiting_review after the upstream
    // agent runs (handled by the scheduler harness).
    const before = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, h.taskId))
    const beforeReviews = before.filter((r) => r.nodeId.startsWith('rev_'))
    expect(beforeReviews.length).toBe(3)
    for (const r of beforeReviews) {
      expect(r.status).toBe('awaiting_review')
      expect(r.reviewIteration).toBe(0)
    }

    // Iterate on design.
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.design,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    // Siblings (proposal + plan) should be reset to pending with reviewIteration++.
    const proposalAfter = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_proposal')))
    )[0]!
    const planAfter = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_plan')))
    )[0]!
    expect(proposalAfter.status).toBe('pending')
    expect(proposalAfter.reviewIteration).toBe(1)
    expect(planAfter.status).toBe('pending')
    expect(planAfter.reviewIteration).toBe(1)

    // Pending doc_versions for siblings (if any) should be marked rejected
    // so the upstream re-run mints a fresh v(n+1).
    const proposalPending = await h.db
      .select()
      .from(docVersions)
      .where(
        and(eq(docVersions.reviewNodeRunId, proposalAfter.id), eq(docVersions.decision, 'pending')),
      )
    expect(proposalPending.length).toBe(0)
  })

  test('approved sibling is pulled back to pending after iterate (RFC-014 #3: even done(approved) cascade)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // First approve proposal so it goes to status=done.
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.proposal,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    const proposalDone = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_proposal')))
    )[0]!
    expect(proposalDone.status).toBe('done')

    // Then iterate on design — proposal review must go back to pending.
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.design,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const proposalAfter = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_proposal')))
    )[0]!
    expect(proposalAfter.status).toBe('pending')
    expect(proposalAfter.reviewIteration).toBeGreaterThan(0)
  })

  test('agent opt-out (syncOutputsOnIterate=false) — siblings stay put on iterate (C5)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: false })
    cleanupHarness = h.cleanup

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.design,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    // Siblings remain awaiting_review (no cascade).
    const proposalAfter = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_proposal')))
    )[0]!
    const planAfter = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_plan')))
    )[0]!
    expect(proposalAfter.status).toBe('awaiting_review')
    expect(proposalAfter.reviewIteration).toBe(0)
    expect(planAfter.status).toBe('awaiting_review')
    expect(planAfter.reviewIteration).toBe(0)
  })

  test('buildSiblingOutputsBlock returns the English instruction + worktree-relative file paths (not bodies)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // RFC-014 updated: the block lists `- {portName}: {sourceFilePath}` lines
    // pulled from doc_versions.source_file_path. The harness emits inline
    // markdown (kind='markdown', no sourceFilePath); to exercise the new
    // path-only contract here we synthesize file paths into the existing
    // sibling doc_versions before invoking the builder.
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: 'design/proposal.md' })
      .where(eq(docVersions.sourcePortName, 'proposal'))
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: 'design/plan.md' })
      .where(eq(docVersions.sourcePortName, 'plan'))

    const block = await buildSiblingOutputsBlock({
      db: h.db,
      appHome: h.appHome,
      taskId: h.taskId,
      upstreamNodeId: 'designer',
      targetPortName: 'design',
    })
    expect(block).toBeDefined()
    expect(block!).toContain('You also produced the following sibling documents.')
    expect(block!).toContain('- proposal: design/proposal.md')
    expect(block!).toContain('- plan: design/plan.md')
    // The target port itself must NOT appear in the path list.
    expect(block!).not.toContain('- design:')
    // The legacy "embed body" behavior is gone — no `### proposal` headings,
    // no body text from the stub.
    expect(block!).not.toContain('### proposal')
    expect(block!).not.toContain('### plan')
    expect(block!).not.toContain('We build B2B platform for orders.')
    expect(block!).not.toContain('Week 1: scaffolding.')
  })

  test('buildSiblingOutputsBlock returns undefined when every sibling is inline (no sourceFilePath)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // Stub emits inline markdown for all three ports → sourceFilePath is
    // null on every doc_version. With RFC-014 §3.2 (updated) "skip inline"
    // policy, the block has nothing to list and returns undefined; downstream
    // the `{{__sibling_outputs__}}` token resolves to empty + no auto-append.
    const block = await buildSiblingOutputsBlock({
      db: h.db,
      appHome: h.appHome,
      taskId: h.taskId,
      upstreamNodeId: 'designer',
      targetPortName: 'design',
    })
    expect(block).toBeUndefined()
  })

  test('buildSiblingOutputsBlock returns undefined when agent opt-out (no sibling cascade fires either)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: false })
    cleanupHarness = h.cleanup

    const block = await buildSiblingOutputsBlock({
      db: h.db,
      appHome: h.appHome,
      taskId: h.taskId,
      upstreamNodeId: 'designer',
      targetPortName: 'design',
    })
    expect(block).toBeUndefined()
  })

  test('buildReviewPromptContext on iterate path populates `siblingOutputs` with paths for opt-in agent (when sibling ports have sourceFilePath)', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // Seed sourceFilePath on the sibling doc_versions before the decision —
    // simulates the upstream agent having used `kind: markdown_file` outputs
    // that wrote into worktree-relative paths.
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: 'design/proposal.md' })
      .where(eq(docVersions.sourcePortName, 'proposal'))
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: 'design/plan.md' })
      .where(eq(docVersions.sourcePortName, 'plan'))

    // Iterate on design so a user-decided doc_version exists.
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.design,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const ctx = await buildReviewPromptContext(h.db, h.appHome, 'designer', h.taskId, 0)
    expect(ctx).toBeDefined()
    expect(ctx!.iterateTargetPort).toBe('design')
    expect(ctx!.siblingOutputs).toBeDefined()
    expect(ctx!.siblingOutputs!).toContain('- proposal: design/proposal.md')
    expect(ctx!.siblingOutputs!).toContain('- plan: design/plan.md')
  })

  test('buildReviewPromptContext on iterate path with opt-out agent leaves `siblingOutputs` undefined', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: false })
    cleanupHarness = h.cleanup

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunIds.design,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const ctx = await buildReviewPromptContext(h.db, h.appHome, 'designer', h.taskId, 0)
    expect(ctx).toBeDefined()
    expect(ctx!.iterateTargetPort).toBe('design')
    expect(ctx!.siblingOutputs).toBeUndefined()
  })

  // RFC-014 latest-doc-version sort: verify the desc() ordering of
  // doc_versions.reviewIteration is what `buildSiblingOutputsBlock` relies on.
  test('buildSiblingOutputsBlock reads the latest doc_version per sibling port', async () => {
    h = await buildHarness({ agentSyncOutputsOnIterate: true })
    cleanupHarness = h.cleanup

    // The harness emitted v0 for all three ports. Confirm the desc query
    // would in fact prefer a higher reviewIteration if it existed.
    const dvForProposal = await h.db
      .select()
      .from(docVersions)
      .where(
        and(
          eq(docVersions.taskId, h.taskId),
          eq(docVersions.sourceNodeId, 'designer'),
          eq(docVersions.sourcePortName, 'proposal'),
        ),
      )
      .orderBy(desc(docVersions.reviewIteration), desc(docVersions.createdAt))
    expect(dvForProposal.length).toBeGreaterThan(0)
    // Sanity: first row has the highest reviewIteration in the set.
    const ris = dvForProposal.map((r) => r.reviewIteration)
    expect(ris[0]).toBe(Math.max(...ris))
  })
})

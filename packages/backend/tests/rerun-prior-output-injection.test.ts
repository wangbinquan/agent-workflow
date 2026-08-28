// RFC-119 — generalized rerun prior-output: scheduler selector + block composer.
//
// Locks the two scheduler helpers that feed `priorOutputUpdate`:
//   - freshestPriorRunWithOutput: the freshest prior TOP-LEVEL run at the same
//     (iteration, shardKey), id < current, that captured ANY output row —
//     REGARDLESS of status. The status-agnostic part is load-bearing: review
//     reject/iterate supersedes the prior `done` row to `canceled` (keeping its
//     node_run_outputs), and the done-only priorDoneGenerationsForRun would miss
//     it (RFC-119 D2). Also pins iteration / shardKey / parent-null / id-cutoff
//     scoping and the "skip rows with no captured output" fallback.
//   - composePriorOutputBlock: declared-output ordering, empty-port drop, and the
//     RFC-119 D10 `onlyPorts` restriction (review-iterate → iterate-target only).
//
// Plus end-to-end shape checks: a canceled (superseded) prior run's outputs are
// readable and render through renderUserPrompt as the `## Prior Output` block,
// and (RFC-141) an ask-back round renders the draft with the ask-back directive
// variant instead of the update pair.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  composePriorOutputBlock,
  freshestPriorRunWithOutput,
} from '../src/modules/task-execution/composition/nodeMechanics'
import {
  ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE,
  ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE,
  PRIOR_OUTPUT_BLOCK_TITLE,
  renderUserPrompt,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const seedUlid = monotonicFactory()

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${seedUlid()}`
  const wfId = `wf_${taskId}`
  const def = '{"schema_version":1,"nodes":[],"edges":[],"inputs":[]}'
  await db.insert(workflows).values({
    id: wfId,
    name: 'rerun-prior-output',
    description: '',
    definition: def,
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: def,
    repoPath: '/tmp/aw-rerun-prior-output',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** Insert a node_run; returns its (monotonic) id. Defaults: top-level done at
 *  iteration 0, shardKey null. */
async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = seedUlid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
    ...fields,
  })
  return id
}

async function seedOutput(
  db: DbClient,
  nodeRunId: string,
  portName: string,
  content: string,
  kind?: string,
): Promise<void> {
  await db.insert(nodeRunOutputs).values({
    nodeRunId,
    portName,
    content,
    ...(kind !== undefined ? { kind } : {}),
  })
}

describe('RFC-119 — freshestPriorRunWithOutput', () => {
  test('returns the done prior run that captured output', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const prior = await seedRun(db, taskId, 'agent', { status: 'done' })
    await seedOutput(db, prior, 'design', '# draft v1')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(prior)
  })

  test('D2: returns a CANCELED (review-superseded) prior run — done-only would miss it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Review reject/iterate flips the prior done row to canceled but keeps its
    // node_run_outputs. The selector MUST still surface it.
    const prior = await seedRun(db, taskId, 'agent', {
      status: 'canceled',
      errorMessage: 'superseded-by-review-iterated',
    })
    await seedOutput(db, prior, 'design', '# rejected draft')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(prior)
    expect(found?.status).toBe('canceled')
  })

  test('no prior run → undefined', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: seedUlid(),
    })
    expect(found).toBeUndefined()
  })

  test('prior at a DIFFERENT iteration is not returned (loop next-iteration is not a rerun)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const priorIter0 = await seedRun(db, taskId, 'agent', { status: 'done', iteration: 0 })
    await seedOutput(db, priorIter0, 'design', '# iter0 output')
    const currentId = seedUlid()

    // Current run is at iteration 1 → the iteration-0 output must NOT leak in.
    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 1,
      shardKey: null,
      id: currentId,
    })
    expect(found).toBeUndefined()
  })

  test('shardKey isolation: only same-shard prior is returned', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const otherShard = await seedRun(db, taskId, 'agent', { status: 'done', shardKey: 'shardB' })
    await seedOutput(db, otherShard, 'design', '# shardB output')
    const sameShard = await seedRun(db, taskId, 'agent', { status: 'done', shardKey: 'shardA' })
    await seedOutput(db, sameShard, 'design', '# shardA output')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: 'shardA',
      id: currentId,
    })
    expect(found?.id).toBe(sameShard)
  })

  test('skips a failed prior with NO output, falls back to an earlier done-with-output', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // done(output) → failed(no output, freshest). Selector skips the failed and
    // returns the earlier done that actually produced output.
    const doneWithOutput = await seedRun(db, taskId, 'agent', { status: 'done' })
    await seedOutput(db, doneWithOutput, 'design', '# the real output')
    const failedNoOutput = await seedRun(db, taskId, 'agent', { status: 'failed' })
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(doneWithOutput)
    void failedNoOutput
  })

  // RFC-119 multi-process (D9 revision): the lookup is PARENT-AGNOSTIC so it can
  // find a fan-out aggregator/shard CHILD (parentNodeRunId set) as the prior run.
  // No node has both top-level AND child runs at the same (nodeId, shardKey), so
  // dropping the parent filter is safe; the (nodeId, shardKey) tuple scopes it.
  test('parent-agnostic: a prior aggregator CHILD (shardKey null) IS found', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const wrapper = await seedRun(db, taskId, 'wrapper', { status: 'done' })
    const priorAgg = await seedRun(db, taskId, 'aggnode', {
      status: 'done',
      parentNodeRunId: wrapper,
    })
    await seedOutput(db, priorAgg, 'summary', '# prior aggregated output')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'aggnode',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(priorAgg)
  })

  test('parent-agnostic shard lineage: matches prior child with the SAME shardKey only', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const wrapper = await seedRun(db, taskId, 'wrapper', { status: 'done' })
    const shardA = await seedRun(db, taskId, 'inner', {
      status: 'done',
      parentNodeRunId: wrapper,
      shardKey: 'fileA',
    })
    await seedOutput(db, shardA, 'audit', '# fileA audit v1')
    const shardB = await seedRun(db, taskId, 'inner', {
      status: 'done',
      parentNodeRunId: wrapper,
      shardKey: 'fileB',
    })
    await seedOutput(db, shardB, 'audit', '# fileB audit')
    const currentId = seedUlid()

    // Looking up shardKey 'fileA' must return the fileA child, NOT fileB.
    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'inner',
      iteration: 0,
      shardKey: 'fileA',
      id: currentId,
    })
    expect(found?.id).toBe(shardA)
  })

  test('returns the FRESHEST among multiple done-with-output priors', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const older = await seedRun(db, taskId, 'agent', { status: 'done' })
    await seedOutput(db, older, 'design', '# v1')
    const newer = await seedRun(db, taskId, 'agent', { status: 'canceled' })
    await seedOutput(db, newer, 'design', '# v2')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(newer)
  })
})

describe('RFC-119 — composePriorOutputBlock', () => {
  test('renders in declared-output order, drops empty ports', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const run = await seedRun(db, taskId, 'agent', { status: 'done' })
    await seedOutput(db, run, 'summary', 'one-liner')
    await seedOutput(db, run, 'design', '# big doc')
    await seedOutput(db, run, 'blank', '   ')

    const block = await composePriorOutputBlock(db, run, ['design', 'summary', 'blank'])
    const designIdx = block.indexOf('### design')
    const summaryIdx = block.indexOf('### summary')
    expect(designIdx).toBeGreaterThan(-1)
    expect(summaryIdx).toBeGreaterThan(designIdx) // declared order: design before summary
    expect(block).toContain('# big doc')
    expect(block).toContain('one-liner')
    expect(block).not.toContain('### blank') // whitespace-only dropped
  })

  test('no captured output → empty string', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const run = await seedRun(db, taskId, 'agent', { status: 'done' })
    expect(await composePriorOutputBlock(db, run, ['design'])).toBe('')
  })

  test('D10 onlyPorts restricts to the given ports (review-iterate target)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const run = await seedRun(db, taskId, 'agent', { status: 'done' })
    await seedOutput(db, run, 'design', '# design body')
    await seedOutput(db, run, 'plan', '# plan body')

    const onlyDesign = await composePriorOutputBlock(
      db,
      run,
      ['design', 'plan'],
      new Set(['design']),
    )
    expect(onlyDesign).toContain('### design')
    expect(onlyDesign).toContain('# design body')
    expect(onlyDesign).not.toContain('### plan')
    expect(onlyDesign).not.toContain('# plan body')
  })

  test('D8 file-port content (a worktree-relative path) renders verbatim', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const run = await seedRun(db, taskId, 'agent', { status: 'done' })
    // markdown_file port: node_run_outputs.content is the path, not the body.
    await seedOutput(db, run, 'auditdoc', 'docs/audit.md', 'markdown_file')

    const block = await composePriorOutputBlock(db, run, ['auditdoc'])
    expect(block).toContain('### auditdoc')
    expect(block).toContain('docs/audit.md')
  })
})

describe('RFC-119 — end-to-end: canceled prior outputs render into the prompt', () => {
  test('superseded run output flows through composePriorOutputBlock → renderUserPrompt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const prior = await seedRun(db, taskId, 'agent', {
      status: 'canceled',
      errorMessage: 'superseded-by-review-rejected',
    })
    await seedOutput(db, prior, 'design', '# the prior draft body')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(prior)

    const block = await composePriorOutputBlock(db, found!.id, ['design'])
    const prompt = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId },
      agentOutputs: ['design'],
      reviewContext: { rejection: 'wrong direction' },
      priorOutputUpdate: { block },
    })
    expect(prompt).toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(prompt).toContain('# the prior draft body')
    expect(prompt).toContain('## Review Rejection')
  })

  test('RFC-141: an ask-back round renders the draft with the ask-back directive variant', async () => {
    // Evidence case: QMGP5 agent_m7p3n1 retry 17 — the node had 4 docpath
    // generations, a cross-clarify answer re-triggered it with mandatory
    // ask-back active, and RFC-119 D6 dropped the draft from the prompt.
    // RFC-141 (user ruling) injects it with the clarify-flavored pair instead.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const prior = await seedRun(db, taskId, 'agent')
    await seedOutput(db, prior, 'docpath', 'docs/snake-game-design.md')
    const currentId = seedUlid()

    const found = await freshestPriorRunWithOutput(db, {
      taskId,
      nodeId: 'agent',
      iteration: 0,
      shardKey: null,
      id: currentId,
    })
    expect(found?.id).toBe(prior)

    const block = await composePriorOutputBlock(db, found!.id, ['docpath'])
    const prompt = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId },
      agentOutputs: ['docpath'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
      clarifyContext: { flatBlock: '## Clarify Q&A\n- Q1 → yes' },
      priorOutputUpdate: { block },
    })
    // draft present, ask-back variant pair, clarify-only protocol intact
    expect(prompt).toContain(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(prompt).toContain('docs/snake-game-design.md')
    expect(prompt).toContain(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE)
    expect(prompt).toContain('MANDATORY ASK-BACK')
    // the update pair must not leak into the ask-back round
    expect(prompt).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(prompt).not.toContain('## Update Directive')
  })
})

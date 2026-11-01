// RFC-398 §11 regression: v0.18.18/v0.18.19 on PostgreSQL left `node_runs.lineage_slot_path_json`
// NULL while every effect of the run's continuation slot recorded the task path. The rows below
// come from the real v0.18.19 L2 capture (PostgreSQL-native clarify task awaiting an answer).
// Before the fix the conversion copied the NULL, the resumed worker run derived a node path,
// opened a second operation family at generation 0 and collided with the recorded effect on
// (task_id, operation_key, operation_generation) — the task failed with iso-setup-failed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { submitReviewDecision } from '@/modules/collaboration/infrastructure/review'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { insertOne } from '@/platform/persistence/singleInsert'
import { runGit } from '../src/util/git'
import { ulid } from 'ulid'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createLocalEffectAttemptObserver } from '@/modules/task-execution/application/localEffectObserver'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq } from 'drizzle-orm'
import { defaultContinuationSlotKey } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import {
  canonicalJson,
  encodeLineageSlotPath,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports, withO2Closure } from './helpers/o2Closure'
import {
  agentFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import {
  LEGACY_EFFECT_SLOT_PATHS,
  legacyEffectSlotPaths,
  legacyRunLineageSlotPath,
  type LegacyEffectSlotPaths,
} from '@/modules/task-execution/infrastructure/migration/run/legacyLineage'
import {
  buildNodeRunMintRecord,
  nodeRunLineageColumns,
} from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { nodeRunMintIdentityForSlot } from '@/modules/task-execution/application/nodeRunMintIdentity'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { operationFamilyKey } from '@/modules/task-execution/public/participants'
import { decodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { LookupResolver } from '@/platform/persistence/migration/conversion/lookups'
import type { StagedReader } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const TASK = '01M6AGQ96V0PCZBMMPMT67KNH7'
const WORKER_SLOT = '59a068716e39443b05c5fc457b4a7706722d655a4060a1a1754933555c679042'
const CLARIFY_SLOT = '9d65062c67f3db7f5c624c652e33ef33d17903e9715eb432a3e3f3ed4117a567'
/** v0.18.19 tasks.lineage_slot_path_json (insertion order, as the old trigger-free writer stored it). */
const TASK_PATH = `[{"stableNodeKey":"task-root","frozenOccurrenceKey":"${TASK}","workflowRevision":1}]`
/** v0.18.19 task_execution_effects.slot_path_json for both worker effects (canonical encoding). */
const RECORDED = `[{"frozenOccurrenceKey":"${TASK}","stableNodeKey":"task-root","workflowRevision":1}]`
const LEGACY_FAMILIES = {
  isolation: '5f54e71f87103b7dd49b7f64f70ece6a89a861a94c076f7a7b629b15eb20e803',
  process: '2749f1c49d6b1d3917bc4d5385e366d47b4de8fc57e3379fd9288b76a3975b42',
}

function row(table: string, values: Record<string, unknown>, codecFailure = false): SourceRow {
  return {
    table,
    values,
    ...(codecFailure ? { codecFailure: { message: 'undecodable', columns: ['x'] } } : {}),
  } as unknown as SourceRow
}

function buildLookup(rows: { node_runs: SourceRow[]; task_execution_effects: SourceRow[] }) {
  const put = new Map<string, LegacyEffectSlotPaths>()
  const staged = {
    group(table: 'node_runs' | 'task_execution_effects', column: string, value: unknown) {
      return rows[table].filter((r) => r.values[column] === value)
    },
  } as unknown as StagedReader
  const lookups = ((key: { id: string }) => {
    expect(key.id).toBe(TASK_FACTS.id)
    return { entries: () => [[TASK, {}] as const, ['other-task', {}] as const] }
  }) as unknown as LookupResolver
  void legacyEffectSlotPaths.build(staged, (key, value) => put.set(key, value), lookups)
  return put
}

test('recorded lineage is kept; NULL takes the single recorded effect path; otherwise NULL stays', () => {
  expect(legacyRunLineageSlotPath(TASK_PATH, [RECORDED])).toBe(TASK_PATH)
  expect(legacyRunLineageSlotPath(null, [RECORDED])).toBe(RECORDED)
  // No effect in the slot: no operation family exists, the runtime may derive a fresh one.
  expect(legacyRunLineageSlotPath(null, undefined)).toBeNull()
  expect(legacyRunLineageSlotPath(null, [])).toBeNull()
  // One released runtime records one path per slot; disagreement is never guessed between.
  expect(legacyRunLineageSlotPath(null, [RECORDED, TASK_PATH])).toBeNull()
})

test('the lookup reads only NULL-lineage runs and matches effects by `${slot}:` prefix', () => {
  expect(LEGACY_EFFECT_SLOT_PATHS.id).toBe('task-execution/run-legacy-effect-slot-paths')
  const paths = buildLookup({
    node_runs: [
      row('node_runs', {
        task_id: TASK,
        lineage_slot_path_json: null,
        continuation_slot_key: WORKER_SLOT,
      }),
      // Recorded lineage (SQLite trigger, v0.19.x writer): never part of the lookup.
      row('node_runs', {
        task_id: TASK,
        lineage_slot_path_json: TASK_PATH,
        continuation_slot_key: CLARIFY_SLOT,
      }),
      row(
        'node_runs',
        { task_id: TASK, lineage_slot_path_json: null, continuation_slot_key: 'undecodable' },
        true,
      ),
      // A NULL-lineage run in another task without effects publishes nothing.
      row('node_runs', {
        task_id: 'other-task',
        lineage_slot_path_json: null,
        continuation_slot_key: WORKER_SLOT,
      }),
    ],
    task_execution_effects: [
      row('task_execution_effects', {
        task_id: TASK,
        operation_key: `${WORKER_SLOT}:isolation-create:isolation-create`,
        slot_path_json: RECORDED,
      }),
      row('task_execution_effects', {
        task_id: TASK,
        operation_key: `${WORKER_SLOT}:process:agent`,
        slot_path_json: RECORDED,
      }),
      // Same leading characters without the `:` boundary belong to a different slot.
      row('task_execution_effects', {
        task_id: TASK,
        operation_key: `${WORKER_SLOT}0:process:agent`,
        slot_path_json: TASK_PATH,
      }),
      row('task_execution_effects', {
        task_id: TASK,
        operation_key: `${CLARIFY_SLOT}:process:agent`,
        slot_path_json: TASK_PATH,
      }),
      row(
        'task_execution_effects',
        {
          task_id: TASK,
          operation_key: `${WORKER_SLOT}:process:agent`,
          slot_path_json: TASK_PATH,
        },
        true,
      ),
    ],
  })
  expect([...paths]).toEqual([[TASK, { [WORKER_SLOT]: [RECORDED] }]])
})

test('the materialized lineage keeps a re-run in the legacy operation family', () => {
  const slot: RunSlot = {
    kind: 'node',
    nodeId: 'worker',
    frame: { containerRunId: null, iteration: 0 },
  }
  const rerun = (inherited: string | null) => {
    const record = buildNodeRunMintRecord({
      ...nodeRunMintIdentityForSlot(slot, { kind: 'current' }),
      taskId: TASK,
      nodeId: 'worker',
      status: 'pending',
      cause: 'retry-node',
      inheritFrom: {
        reviewIteration: 0,
        parentNodeRunId: null,
        containerRunId: null,
        shardKey: null,
        checkpointInheritance: [],
        continuationSlotKey: WORKER_SLOT,
        lineageSlotPathJson: inherited,
        operationGeneration: 0,
      },
    })
    const columns = nodeRunLineageColumns(record, {
      lineageSlotPathJson: TASK_PATH,
      workflowVersion: 1,
    })
    expect(columns.continuationSlotKey).toBe(WORKER_SLOT)
    const slotPath = decodeLineageSlotPath(columns.lineageSlotPathJson)
    return {
      isolation: operationFamilyKey({
        executionLineageId: TASK,
        slotPath,
        effectKind: 'isolation-create',
        stableActionOrdinal: 'isolation-create',
      }),
      process: operationFamilyKey({
        executionLineageId: TASK,
        slotPath,
        effectKind: 'process',
        stableActionOrdinal: 'managed-agent',
      }),
    }
  }
  // Converted run: the re-run inherits the recorded path and continues both legacy families,
  // so the next generation is 1 and (task_id, operation_key, 0) stays unique.
  expect(rerun(legacyRunLineageSlotPath(null, [RECORDED]))).toEqual(LEGACY_FAMILIES)
  // The copied NULL reproduced the failure: a node-level path opens new families at generation 0.
  const split = rerun(null)
  expect(split.isolation).not.toBe(LEGACY_FAMILIES.isolation)
  expect(split.process).not.toBe(LEGACY_FAMILIES.process)
})

// Through the real review decision, local effect observer and effect ledger (both providers).
// Codex implementation gate r2 P1: review reject / iterate re-minted the upstream run without
// `inheritFrom`, so the converted lineage alone was not enough — the review rerun must keep the
// replaced run's slot and lineage, as every other rerun path already does.
const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

const docSlot = defaultContinuationSlotKey({ nodeId: 'doc', iteration: 0, shardKey: null })

/** A claimed task and the real local effect observer the isolation step uses. */
async function claimedTask(h: ProviderHarness, taskId: string) {
  const persistence = createTaskExecutionPersistence(h.db, {
    humanGateOpen: composeHumanGateOpenParticipantFactory(),
    historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
    recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
  })
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  // The review decision admitted its continuation intent; claim it like the scheduler would.
  const { taskExecutionIntents } = tablesOf(h.db)
  const [pending] = await h.db
    .select({ id: taskExecutionIntents.id })
    .from(taskExecutionIntents)
    .where(and(eq(taskExecutionIntents.taskId, taskId), eq(taskExecutionIntents.state, 'pending')))
  const intentId = pending!.id
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const context = createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return {
    /** beforeAct + succeed for one isolation effect of `nodeRunId`, exactly as the runtime does. */
    async isolate(nodeRunId: string) {
      const observer = createLocalEffectAttemptObserver({
        persistence: persistence.effects,
        taskId,
        nodeRunId,
        kind: 'isolation-create',
        stableActionOrdinal: 'isolation-create',
        candidateId: nodeRunId,
        request: { v: 1, run: nodeRunId },
        resourceKeys: [`rfc398:${nodeRunId}`],
        context,
      })!
      await observer.beforeAct()
      await observer.succeed({ run: nodeRunId })
    },
    close: () => module.resetForTesting(),
  }
}

async function effects(h: ProviderHarness, taskId: string) {
  const { taskExecutionEffects } = tablesOf(h.db)
  return (
    await h.db
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.taskId, taskId))
      .orderBy(asc(taskExecutionEffects.operationGeneration))
  ).map((row) => ({
    operationKey: String(row.operationKey),
    generation: Number(row.operationGeneration),
    family: String(row.operationFamilyKey),
    slotPathJson: String(row.slotPathJson),
  }))
}

describeEachProvider('RFC-398 §11 review reject of a converted v0.18.x run', (h) => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rfc398-review-lineage-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** doc → rev_1 awaiting review; the upstream doc run carries `upstreamLineage`. */
  async function awaitingReview(upstreamLineage: (taskId: string) => string) {
    const appHome = join(root, 'appHome')
    const worktree = join(root, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const git = async (args: string[]) => {
      const result = await runGit(worktree, args)
      if (result.exitCode !== 0) throw new Error(result.stderr.trim())
      return result.stdout.trim()
    }
    await git(['init', '-q', '-b', 'main'])
    await git(['config', 'user.email', 'rfc398@test.invalid'])
    await git(['config', 'user.name', 'rfc398'])
    writeFileSync(join(worktree, 'doc.txt'), 'v1\n', 'utf8')
    await git(['add', 'doc.txt'])
    await git(['commit', '-q', '-m', 'snapshot'])
    const snapshot = await git(['rev-parse', 'HEAD'])
    await agentFixture(h.db, {
      id: ulid(),
      name: 'doc',
      description: '',
      outputs: JSON.stringify(['design']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'doc', portName: 'design' },
          rerunnableOnIterate: ['doc'],
          rerunnableOnReject: ['doc'],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await workflowFixture(h.db, {
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await taskFixture(h.db, {
      id: taskId,
      name: 'rfc398-review-lineage',
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(rootPath(taskId)),
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      workflowVersion: 1,
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const upstreamId = ulid()
    await nodeRunFixture(h.db, {
      id: upstreamId,
      taskId,
      nodeId: 'doc',
      iteration: 0,
      retryIndex: 0,
      status: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
      continuationSlotKey: docSlot,
      lineageSlotPathJson: upstreamLineage(taskId),
      checkpoints: [{ mountPath: '', preSnapshot: snapshot }],
    })
    await nodeRunOutputFixture(h.db, {
      nodeRunId: upstreamId,
      portName: 'design',
      content: '# design',
    })
    const reviewRunId = ulid()
    await nodeRunFixture(h.db, {
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: Date.now() - 200,
    })
    const bodyRel = `runs/${taskId}/review/rev_1/design/v1.md`
    mkdirSync(join(appHome, `runs/${taskId}/review/rev_1/design`), { recursive: true })
    writeFileSync(join(appHome, bodyRel), '# design', 'utf8')
    await insertOne(h.db, tablesOf(h.db).docVersions, {
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'design',
      versionIndex: 1,
      reviewIteration: 0,
      ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', bodyRel)),
      commentsJson: '[]',
      decision: 'pending',
      createdAt: Date.now() - 100,
    })
    await submitReviewDecision(
      withO2Closure({
        db: h.db,
        appHome,
        nodeRunId: reviewRunId,
        decision: 'rejected',
        rejectReason: 'wrong direction',
        expectedReviewIteration: 0,
      }),
    )
    const runs = await readNodeRunFixtures(h.db, { $and: [{ taskId }, { nodeId: 'doc' }] })
    const rerun = runs.find((run) => run.id !== upstreamId)!
    expect(rerun.status).toBe('pending')
    return { taskId, upstreamId, rerun }
  }

  test('the rerun keeps the converted lineage and continues its operation family', async () => {
    const legacyPath = (taskId: string) => encodeLineageSlotPath(rootPath(taskId))
    const { taskId, upstreamId, rerun } = await awaitingReview(legacyPath)
    expect(rerun.continuationSlotKey).toBe(docSlot)
    expect(rerun.lineageSlotPathJson).toBe(legacyPath(taskId))
    const task = await claimedTask(h, taskId)
    try {
      // The converted run's v0.18.x effect (task-level family, generation 0), then the rerun's.
      await task.isolate(upstreamId)
      await task.isolate(rerun.id)
      // (The reject also records its own workspace-rollback effect; only the isolation key matters.)
      const isolationKey = `${docSlot}:isolation-create:isolation-create`
      const rows = (await effects(h, taskId)).filter((row) => row.operationKey === isolationKey)
      expect(rows.map((row) => [row.generation, row.slotPathJson])).toEqual([
        [0, legacyPath(taskId)],
        [1, legacyPath(taskId)],
      ])
      expect(rows[1]!.family).toBe(rows[0]!.family)
    } finally {
      task.close()
    }
  })

  test('an ordinary rerun keeps the lineage the replaced run recorded', async () => {
    const derived = (taskId: string) =>
      encodeLineageSlotPath([
        ...rootPath(taskId),
        { stableNodeKey: 'doc', frozenOccurrenceKey: '0|', workflowRevision: 1 },
      ])
    const { taskId, rerun } = await awaitingReview(derived)
    expect(rerun.continuationSlotKey).toBe(docSlot)
    expect(rerun.lineageSlotPathJson).toBe(derived(taskId))
  })
})

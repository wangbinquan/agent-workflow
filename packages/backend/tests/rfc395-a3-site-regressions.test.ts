// RFC-395 II-a A3 sites fix round: B1/B5/B10/SA7 must observe migrated sites and exact bytes,
// not merely repeat reader calls. Private site bodies are evaluated with external effects bound.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { REPO_PREP_NODE_ID, isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskRequestedSourceColumns } from '@/platform/persistence/taskRepositorySql'
import { decodeRequestedSource } from '@/platform/persistence/taskRepositorySurface'
import {
  createNodeRunQueries,
  createRunSelectionReader,
  createRunSelectionOracleSnapshot,
  createRunHistorySnapshot,
  createTaskPreparationQueries,
} from '@/modules/task-execution/public/queries'
import { prepareConsumedInputs } from '@/modules/task-execution/public/participants'
import { PersistedRepositoryPreparationStep } from '@/modules/task-execution/application/drive/repositoryPreparationStep'
import type { TaskDriveContext } from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture, nodeRunFixture, patchTaskFixture } from './helpers/model'
import { wakeSnapshotOf } from './helpers/workgroupWake'
import { rfc395SourceFunction } from './helpers/rfc395SourceFunction'
import { parseConsumedJson as headParseConsumedJson } from './helpers/rfc395HeadConsumed'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

const taskPath = 'services/task.ts'
const retryPath = 'modules/task-execution/infrastructure/repositoryPreparationRetryCommand.ts'
const siteBindings = {
  tablesOf,
  eq,
  REPO_PREP_NODE_ID,
  isTaskWorkspaceUnbound,
  taskRequestedSourceColumns,
  decodeRequestedSource,
  createNodeRunQueries,
  createRunSelectionReader,
  // RFC-395 II-a A7: B1 now reads the preparation port.
  createTaskPreparationQueries,
  ConflictError,
  DomainError,
  NotFoundError,
}

describeEachProvider('RFC-395 A3 migrated synthetic sites', (harness) => {
  async function seed() {
    const definition = { $schema_version: 2, inputs: [], nodes: [], edges: [] }
    await workflowFixture(harness.db, { id: 'site-workflow', name: 'site-workflow', definition })
    await taskFixture(harness.db, {
      id: 'site-task',
      workflowId: 'site-workflow',
      workflowSnapshot: definition,
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'main',
      repoGroupId: 'group',
      status: 'running',
      inputs: {},
      startedAt: 0,
    })
  }
  function prepStep(effects: string[]) {
    const create = rfc395SourceFunction<
      (input: {
        deps: { db: PersistenceDb }
        appHome: string
      }) => PersistedRepositoryPreparationStep
    >(taskPath, 'createPersistedRepositoryPreparationStep', {
      ...siteBindings,
      PersistedRepositoryPreparationStep,
      getTask: async () => ({ id: 'site-task' }),
      taskDriveComposition: {
        hasDurableRepositoryPreparation: async () => {
          effects.push('prior-check')
          return false
        },
      },
      withTaskExecutionWrite: async (_db: unknown, body: (tx: unknown) => Promise<void>) => {
        effects.push('owner-write')
        await body({})
      },
      fenceTaskWrite: async () => {
        effects.push('fence')
      },
      reclaimStalePrepArtifacts: async () => {
        effects.push('cleanup')
      },
      createMaterializedSpaceCleanup: () => ({}),
      runDeferredRepoPreparation: async () => {
        effects.push('prepare')
        return { ok: true }
      },
    })
    return create({ deps: { db: harness.db }, appHome: '/unused/site-test' })
  }
  test('B1 first preparation reaches prepare without retry-only work; a prior attempt takes that path', async () => {
    await seed()
    const effects: string[] = []
    const context = { taskId: 'site-task', execution: {} } as TaskDriveContext
    expect(await prepStep(effects).run(context)).toEqual({ kind: 'ready' })
    expect(effects).toEqual(['prepare'])
    await nodeRunFixture(harness.db, {
      id: 'prior-prep',
      taskId: 'site-task',
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      retryIndex: 8,
    })
    effects.length = 0
    expect(await prepStep(effects).run(context)).toEqual({ kind: 'ready' })
    expect(effects).toEqual(['prior-check', 'owner-write', 'fence', 'cleanup', 'prepare'])
  })
  test('B10 G6 retry site picks retryIndex before seq and reports a missing attempt', async () => {
    await seed()
    await patchTaskFixture(harness.db, { id: 'site-task' }, { status: 'failed' })
    type Snapshot = { prep: { id: string; retryIndex: number } }
    const load = rfc395SourceFunction<(dependencies: object, taskId: string) => Promise<Snapshot>>(
      retryPath,
      'loadRetrySnapshot',
      {
        ...siteBindings,
        RETRYABLE_TASK_STATUSES: ['failed', 'interrupted'],
        RETRYABLE_PREP_STATUSES: ['failed', 'interrupted'],
        retryPreparationInput: () => ({}),
        retryGitIdentity: () => null,
      },
    )
    const deps = { db: harness.db, awaitTaskSettled: async () => {}, isTaskActive: () => false }
    await expect(load(deps, 'site-task')).rejects.toMatchObject({ code: 'repo-prep-run-missing' })
    await nodeRunFixture(harness.db, {
      id: 'prep-high',
      taskId: 'site-task',
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      retryIndex: 8,
    })
    await nodeRunFixture(harness.db, {
      id: 'prep-late',
      taskId: 'site-task',
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      retryIndex: 1,
    })
    expect((await load(deps, 'site-task')).prep).toMatchObject({ id: 'prep-high', retryIndex: 8 })
  })
  test('B10 G6 commit recovery is task-wide: a newer failed sibling suppresses the older interrupted commit', async () => {
    await seed()
    const rows = [
      { id: 'parent', nodeId: 'agent', seq: 1, status: 'done' },
      {
        id: 'old-commit',
        nodeId: '__commit_push__',
        seq: 2,
        status: 'interrupted',
        parentNodeRunId: 'parent',
        rerunCause: 'commit-push',
      },
      {
        id: 'late-commit',
        nodeId: '__commit_push__:next',
        seq: 3,
        status: 'failed',
        parentNodeRunId: 'other-parent',
        rerunCause: 'commit-push',
      },
    ] as const
    for (const row of rows) await nodeRunFixture(harness.db, { ...row, taskId: 'site-task' })
    const started: string[] = []
    const resume = rfc395SourceFunction<(rows: unknown) => Promise<void>>(
      'modules/task-execution/composition/taskDagScope.ts',
      'resumeInterruptedCommitPush',
      {
        createRunSelectionOracleSnapshot,
        commitPushResumePending: true,
        state: { task: { id: 'site-task' }, topLevelIds: new Set(['agent']) },
        scopeNodeById: new Map([['agent', { id: 'agent' }]]),
        opts: {
          persistence: {
            nodeRuns: {
              transition: async () => {
                throw new Error('unexpected cancellation')
              },
            },
          },
        },
        log: { info() {} },
        startCommitPush: (node: { id: string }) => {
          started.push(node.id)
        },
      },
    )
    const facts = await createNodeRunQueries(harness.db).list({ taskId: 'site-task' })
    await resume(facts)
    expect(started).toEqual([])
    await resume(facts.filter((row) => row.id !== 'late-commit'))
    expect(started).toEqual(['agent'])
  })
})

describe('RFC-395 A3 source lookup and designer anchors', () => {
  test('SA7 encoder preserves computed own keys and the review site retains HEAD lookup semantics', async () => {
    for (const sourceNodeId of [
      'source',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ]) {
      const record = { [sourceNodeId]: 'source-run' }
      expect(prepareConsumedInputs({ record }).consumedUpstreamRunsJson).toBe(
        JSON.stringify(record),
      )
      for (const json of [
        null,
        '{}',
        'invalid',
        JSON.stringify(record),
        JSON.stringify({ [sourceNodeId]: 'old' }),
      ]) {
        const covers = rfc395SourceFunction<(row: { id: string }) => Promise<boolean>>(
          'modules/collaboration/infrastructure/review.ts',
          'coversSource',
          {
            sourceNodeId,
            sourceRun: { id: 'source-run' },
            createRunSelectionOracleSnapshot: () => ({
              consumed: async () =>
                Object.entries(headParseConsumedJson(json)).map(
                  ([producerNodeId, producerRunId]) => ({ producerNodeId, producerRunId }),
                ),
            }),
          },
        )
        const prior = headParseConsumedJson(json)[sourceNodeId]
        expect(await covers({ id: 'review' })).toBe(prior === undefined || prior === 'source-run')
      }
    }
  })
  test('B5 a consumed designer trigger cannot coalesce the still-open ledger with a different chain', async () => {
    type Ledger = { open: boolean; borrowAgentName: string | null; anchorRunIds: Set<string> }
    const entries = [
      { id: 'a', triggerRunId: 'consumed-anchor' },
      { id: 'b', triggerRunId: 'open-anchor' },
    ]
    const db = { select: () => ({ from: () => ({ where: () => entries }) }) }
    const resolveDesigner = rfc395SourceFunction<
      (
        db: unknown,
        task: string,
        node: string,
        iteration: number,
        definition: unknown,
      ) => Promise<Ledger>
    >(
      'modules/collaboration/infrastructure/taskQuestionDispatch.ts',
      'resolveDesignerBorrowForNode',
      {
        tablesOf: () => ({ taskQuestions: {} }),
        and: () => undefined,
        eq: () => undefined,
        isNotNull: () => undefined,
        CLOSED_LEDGER: { open: false, borrowAgentName: null, anchorRunIds: new Set() },
        effectiveTarget: () => 'designer',
        createNodeRunQueries: () => ({ listDispatchFacts: async () => [] }),
        runIdsWithOutput: async () => new Set(),
        isDispatchedEntryConsumed: async (entry: { id: string }) => entry.id === 'a',
        isBorrowHomeFor: () => false,
      },
    )
    const designer = await resolveDesigner(db, 'task', 'designer', 0, {})
    expect([...designer.anchorRunIds]).toEqual(['open-anchor'])
    const resolveBorrow = rfc395SourceFunction<
      (
        db: unknown,
        task: string,
        node: string,
        iteration: number,
        definition: unknown,
      ) => Promise<unknown>
    >('modules/collaboration/infrastructure/taskQuestionDispatch.ts', 'resolveBorrowForNode', {
      tablesOf: () => ({ taskQuestions: {} }),
      and: () => undefined,
      eq: () => undefined,
      isNotNull: () => undefined,
      ConflictError,
      resolveDesignerBorrowForNode: async () => designer,
      resolveDeferredSelfQuestionerBorrowForNode: async () => ({
        open: true,
        borrowAgentName: null,
        anchorRunIds: new Set(['consumed-anchor']),
      }),
      ledgerDesc: () => 'open',
      TASK_QUESTION_CONFLICT: { borrowLedgerConflict: 'borrow-ledger-conflict' },
    })
    const dispatchedDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => [{ id: 'dispatched' }] }) }) }),
    }
    await expect(resolveBorrow(dispatchedDb, 'task', 'designer', 0, {})).rejects.toMatchObject({
      code: 'borrow-ledger-conflict',
    })
  })
})

test('B10 wake fixtures use production selection for twelve NULL-seq host rows', async () => {
  const { snapshot } = await wakeSnapshotOf({
    config: {
      workgroupId: 'wg',
      workgroupName: 'wg',
      mode: 'free_collab',
      leaderMemberId: null,
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 20,
      completionGate: false,
      instructions: '',
      goal: '',
      members: [],
    },
    assignments: [],
    messages: [],
    cursors: new Map(),
    budgetUsed: 12,
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
  })
  // HEAD's NULL-seq fallback compares IDs lexically: "9" follows "11".
  expect(snapshot.hostRuns.filter((row) => row.selection.current).map((row) => row.id)).toEqual([
    'wake-budget-member-9',
  ])
  expect(
    snapshot.hostRuns.find((row) => row.id === 'wake-budget-member-9')?.selection.sequence,
  ).toBe(11)
  expect(
    snapshot.hostRuns.find((row) => row.id === 'wake-budget-member-11')?.selection.current,
  ).toBe(false)
})

test('A3 item 9 repair sites keep HEAD task-wide seq ordering, hinted review precedence and active-status filters', async () => {
  const rows = [
    {
      id: 'z-old',
      nodeId: 'review',
      seq: 1,
      status: 'awaiting_review',
      iteration: 1,
      containerRunId: 'old-frame',
    },
    {
      id: 'a-new',
      nodeId: 'review',
      seq: 2,
      status: 'awaiting_review',
      iteration: 2,
      containerRunId: 'new-frame',
    },
    { id: 'later-failed', nodeId: 'review', seq: 3, status: 'failed', iteration: 3 },
  ]
  const path = 'modules/task-execution/infrastructure/taskRouteRepairOperations.ts'
  const preflight = rfc395SourceFunction<
    (deps: object, option: string, ctx: object) => Promise<{ action: Record<string, unknown> }>
  >(path, 'preflight', {
    ACTIVITY_GATED_OPTIONS: new Set(),
    tablesOf: () => ({ nodeRuns: {} }),
    and: () => undefined,
    eq: () => undefined,
    inArray: () => undefined,
    createRunHistorySnapshot,
    detailStrings: (detail: Record<string, unknown>, key: string) => detail[key],
    repairHintNodeRunId: (detail: { hint?: string }) => detail.hint ?? null,
    isReviewNode: () => true,
    loadNodeRuns: async () => rows,
    loadNodeRun: async (_db: unknown, _task: string, id: string) =>
      rows.find((row) => row.id === id) ?? null,
    deriveScopeRoot: async () => null,
    available: (action: object) => ({ action }),
    unavailable: (reason: string) => {
      throw new Error(reason)
    },
  })
  const deps = {
    db: { select: () => ({ from: () => ({ where: () => rows }) }) },
    clarify: { latestClosedForNodeRun: async () => ({ roundId: 'round', status: 'answered' }) },
  }
  const ctx = {
    task: { id: 'task', status: 'awaiting_review' },
    definition: { nodes: [{ id: 'review' }] },
    alert: { detail: { nodeRunIds: rows.map((row) => row.id) } },
  }
  expect((await preflight(deps, 'U1.cancel-older-keep-newest', ctx)).action).toMatchObject({
    keep: 'a-new',
    cancel: ['z-old'],
  })
  expect((await preflight(deps, 'U1.cancel-newer-keep-oldest', ctx)).action).toMatchObject({
    keep: 'z-old',
    cancel: ['a-new'],
  })
  expect((await preflight(deps, 'S1.recreate-doc-version', ctx)).action.iteration).toBe(2)
  expect(
    (
      await preflight(deps, 'S1.recreate-doc-version', {
        ...ctx,
        alert: { detail: { hint: 'z-old' } },
      })
    ).action.iteration,
  ).toBe(1)
  rows[0]!.status = 'awaiting_human'
  rows[1]!.status = 'awaiting_human'
  expect(
    (
      await preflight(deps, 'S2.reopen-session', {
        ...ctx,
        task: { id: 'task', status: 'awaiting_human' },
      })
    ).action.nodeRunId,
  ).toBe('a-new')
})

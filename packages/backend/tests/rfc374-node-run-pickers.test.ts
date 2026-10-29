// Released picker oracle; executable runtime selection is covered through RunSelectionReader.
import {
  pickLatestSettledRun,
  pickLatestRunInFrame,
  pickFrameSourceRun,
  pickReusableShardRun,
  pickFreshestRun,
} from './helpers/model/frozenSelection/pickers'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { withO2Closure, o2Ports } from './helpers/o2Closure'
// RFC-374 T7/T10: inverted IDs exercise freshness, rollback, frame/branch projections, memory and real persistence readers.
import { createRunHistorySnapshot } from '@/modules/task-execution/public/queries'
import { nodeRunOutputFixture, patchTaskFixture, readNodeRunFixtures } from './helpers/model'

import { describe, expect, test } from 'bun:test'

import {
  buildFreshestSettledPerNode,
  type NodeRunRow,
} from '@/modules/task-execution/application/runProvenance'
import { selectResumeRollbackTargets, selectSyncRollbackTargets } from '@/services/task'

import { compareNodeRunsForTimeline } from '@/services/reviewRoundStart'
import { resolveNodeScope } from '@/services/structuralDiff/refSelect'
import { getTaskBranchTrace } from '@/modules/task-execution/application/branchTrace'
import { loadInjectedSnapshotFromFirstAttempt } from '@/modules/memory/application/injection/injectMemory'
import {
  deriveWorkgroupRunHistory,
  deriveMemberCurrentRuns,
  deriveBudgetUsed,
} from './helpers/workgroupSelection'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { freshestPriorRunWithOutput } from '@/modules/task-execution/composition/nodeMechanics'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { ALL_TOOLS } from '@/mcp/tools'
import { createBoundMcpOperationHandles } from '@/mcp/operationClient'
import { MCP_TOOL_BINDINGS } from '@/mcp/operationBindings'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecutionCore,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { describeEachProvider } from './helpers/eachProvider'
import { deriveFrontier } from './helpers/frontierSelection'
import { isTargetNodeConsumed } from '@/modules/collaboration/infrastructure/clarify/rerunLedger'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { buildHarness, insertAlert, readNodeRunStatus } from './lifecycle-repair-harness'
import { seedSequenceTask, mintSequenceRun } from './helpers/rfc374Fixtures'

const frame = { containerRunId: null, iteration: 0 }
function row(
  id: string,
  seq: number,
  extra: Partial<NodeRunRow> = {},
): NodeRunRow & { shardValueHash: null; scopePath: string } {
  return {
    id,
    seq,
    nodeId: 'n',
    status: 'done',
    iteration: 0,
    parentNodeRunId: null,
    containerRunId: null,
    mergeState: null,
    shardKey: null,
    consumedUpstreamRunsJson: null,
    supersededByReview: null,
    wrapperProgressJson: null,
    shardValueHash: null,
    scopePath: '',
    ...extra,
  }
}
describe('RFC-374 pure selection', () => {
  test('skip-release evidence chooses the newest changed upstream, even when its ID is smaller', async () => {
    const definition: WorkflowDefinition = {
      $schema_version: 7,
      inputs: [],
      edges: [],
      nodes: [
        { id: 'u1', kind: 'input' },
        { id: 'u2', kind: 'input' },
        { id: 'n', kind: 'agent-single' },
      ],
    }
    const result = await deriveFrontier(
      [
        row('z-upstream', 2, { nodeId: 'u1' }),
        row('a-upstream', 3, { nodeId: 'u2' }),
        row('skipped', 1, {
          status: 'skipped',
          consumedUpstreamRunsJson: JSON.stringify({ u1: 'old-u1', u2: 'old-u2' }),
        }),
      ],
      definition,
      definition.nodes,
      new Set(['u1', 'u2', 'n']),
      frame,
      new Map([['n', ['u1', 'u2']]]),
      new Set(),
      new Set(['n']),
      new Set(),
    )
    expect(result.pendingAnchors.get('n')).toBe('a-upstream')
  })
  test('clarify consumption resolves the trigger generation and requires later output', async () => {
    const anchor = {
      ...row('z', 1, { status: 'failed' }),
      rerunCause: 'initial',
      startedAt: null,
      supersededByReview: null,
    }
    const next = {
      ...row('a', 2),
      rerunCause: 'clarify-answer',
      startedAt: null,
      supersededByReview: null,
    }
    expect(await isTargetNodeConsumed('n', 0, anchor.id, [anchor, next], new Set([next.id]))).toBe(
      true,
    )
    expect(await isTargetNodeConsumed('n', 0, next.id, [anchor, next], new Set([anchor.id]))).toBe(
      false,
    )
    expect(await isTargetNodeConsumed('n', 0, anchor.id, [anchor, next], new Set())).toBe(false)
  })
  test('a later revival excludes an interrupted clarify continuation from the workgroup budget', async () => {
    const old = {
      ...row('z', 1, { nodeId: '__wg_leader__', status: 'interrupted' }),
      rerunCause: 'clarify-answer',
      wgRound: null,
    }
    const next = {
      ...row('a', 2, { nodeId: '__wg_leader__' }),
      rerunCause: 'revival',
      wgRound: null,
    }
    expect(await deriveBudgetUsed('leader_worker', [next, old])).toBe(1)
    expect(await deriveBudgetUsed('leader_worker', [{ ...next, shardKey: 'other' }, old])).toBe(2)
  })
  test('all sanctioned freshness pickers prefer mint order, preserving scope and status boundaries', async () => {
    const old = row('z', 1),
      fresh = row('a', 2),
      rows = [fresh, old]
    // Epoch-2 execution never orders an unresolved history row by its ID.
    await expect(
      createRunHistorySnapshot('', [old, row('zz', null as unknown as number)]).familyHistory(
        '',
        {},
      ),
    ).rejects.toThrow('run-sequence-required:zz')
    for (const pick of [pickFreshestRun, pickLatestSettledRun])
      expect(pick(rows)?.id).toBe(fresh.id)
    expect(pickLatestRunInFrame(rows, frame)?.id).toBe(fresh.id)
    expect(pickFrameSourceRun(rows, frame)?.id).toBe(fresh.id)
    expect(pickReusableShardRun(rows, { shardKey: null, valueHash: null })?.id).toBe(fresh.id)
    expect((await buildFreshestSettledPerNode(rows, new Set(['n']), frame)).get('n')?.id).toBe(
      fresh.id,
    )
    expect(pickFrameSourceRun([old, row('0', 3, { status: 'pending' })], frame)?.id).toBe(old.id)
    expect(pickLatestRunInFrame(rows, { containerRunId: 'other', iteration: 0 })).toBeUndefined()
    expect(pickFreshestRun([])).toBeUndefined()
  })
  test('rollback and timeline decisions retain their existing primary keys', async () => {
    const old = row('z', 1, { status: 'failed' }),
      fresh = row('a', 2, { status: 'interrupted' })
    expect((await selectResumeRollbackTargets([fresh, old])).map((run) => run.id)).toEqual(['a'])
    expect(
      (await selectSyncRollbackTargets([old, fresh], ['failed', 'interrupted'], () => false)).map(
        (run) => run.id,
      ),
    ).toEqual(['a'])
    expect(await selectResumeRollbackTargets([old, { ...fresh, status: 'done' }])).toEqual([])
    expect(
      compareNodeRunsForTimeline({ ...old, startedAt: 10 }, { ...fresh, startedAt: 10 }),
    ).toBeLessThan(0)
    expect(
      compareNodeRunsForTimeline({ ...old, startedAt: 20 }, { ...fresh, startedAt: 10 }),
    ).toBeGreaterThan(0)
    expect(
      resolveNodeScope(
        [
          { ...old, startedAt: 10, snapshotRef: 'old' },
          { ...fresh, startedAt: 10, snapshotRef: 'new' },
        ],
        old.id,
      ),
    ).toEqual({ kind: 'between', fromRef: 'old', toRef: 'new' })
  })
  test('branch trace keeps iteration primary, then seq for a tied generation', async () => {
    const runs = [
      { ...row('z', 1), errorMessage: null },
      { ...row('a', 2, { status: 'skipped' }), errorMessage: 'closed' },
    ]
    const trace = await getTaskBranchTrace(
      {
        async read() {
          return {
            workflowSnapshot: JSON.stringify({
              $schema_version: 2,
              inputs: [],
              nodes: [{ id: 'n', kind: 'output', label: 'n', inputs: [] }],
              edges: [],
            }),
            runs,
            outputs: [],
          }
        },
        history: (taskId, rows) => createRunHistorySnapshot(taskId, rows),
      },
      't',
    )
    expect(trace?.skippedNodes.map((entry) => entry.nodeId)).toEqual(['n'])
  })
  test('memory inheritance resolves a run ID to its seq anchor, including missing anchor fallback', async () => {
    const snapshot = [
      {
        id: 'memory',
        version: 1,
        scopeType: 'agent' as const,
        scopeId: 'a',
        title: 't',
        bodyMd: 'body',
        tags: [],
        sourceKind: 'review',
        approvedAt: null,
      },
    ]
    const records = [
      { id: 'z', seq: 1, status: 'done' as const, injectedMemoriesJson: '[]' },
      {
        id: 'b',
        seq: 2,
        status: 'failed' as const,
        injectedMemoriesJson: JSON.stringify(snapshot),
      },
      { id: 'a', seq: 3, status: 'running' as const, injectedMemoriesJson: null },
    ]
    const unused = async (): Promise<never> => {
      throw new Error('unrelated memory read')
    }
    const store = {
      listRunRecords: async () => records,
      findTaskContext: unused,
      listTaskRepositoryIds: unused,
      filterExistingRepositoryIds: unused,
      listApprovedMemories: unused,
    }
    const ctx = {
      taskId: 't',
      nodeId: 'n',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
      runId: 'a',
    }
    expect(await loadInjectedSnapshotFromFirstAttempt(store, ctx)).toEqual(snapshot)
    expect(
      await loadInjectedSnapshotFromFirstAttempt(store, { ...ctx, runId: 'missing' }),
    ).toBeNull()
  })
  test('workgroup history and current member retain running precedence and use seq within it', async () => {
    const members = [{ id: 'leader', memberType: 'agent' as const }]
    const runs = [
      { ...row('z', 1, { nodeId: '__wg_leader__' }), rerunCause: 'wg-leader-round', wgRound: 1 },
      { ...row('a', 2, { nodeId: '__wg_leader__' }), rerunCause: 'wg-leader-round', wgRound: 2 },
    ]
    expect(
      (await deriveWorkgroupRunHistory(members, 'leader', runs, [], [])).map(
        (run) => run.nodeRunId,
      ),
    ).toEqual(['z', 'a'])
    expect((await deriveMemberCurrentRuns(members, 'leader', runs, [], [])).leader?.nodeRunId).toBe(
      'a',
    )
    expect(
      (
        await deriveMemberCurrentRuns(
          members,
          'leader',
          [{ ...runs[0]!, status: 'running' }, runs[1]!],
          [],
          [],
        )
      ).leader?.nodeRunId,
    ).toBe('z')
  })
})
describeEachProvider('RFC-374 selected persistence consumers', (harness) => {
  for (const keepNewest of [true, false])
    test(`duplicate-run repair keeps the ${keepNewest ? 'newest' : 'oldest'} mint independently of ID order`, async () => {
      const h = await buildHarness(harness.db, { taskStatus: 'awaiting_review' })
      try {
        for (const id of ['z-old', 'a-new'])
          await mintSequenceRun(h.db, h.taskId, { id, nodeId: 'rev_1', status: 'awaiting_review' })
        const alertId = await insertAlert(h.db, h.taskId, {
          rule: 'U1',
          detail: {
            rule: 'U1',
            key: 'rev_1|0|',
            nodeRunIds: ['z-old', 'a-new'],
            statuses: ['awaiting_review', 'awaiting_review'],
          },
        })
        const result = await h.engine.applyRepairOption({
          taskId: h.taskId,
          alertId,
          optionId: keepNewest ? 'U1.cancel-older-keep-newest' : 'U1.cancel-newer-keep-oldest',
          actorUserId: 'rfc374',
        })
        expect(result.outcome).toBe('success')
        expect(await readNodeRunStatus(h.db, keepNewest ? 'a-new' : 'z-old')).toBe(
          'awaiting_review',
        )
        expect(await readNodeRunStatus(h.db, keepNewest ? 'z-old' : 'a-new')).toBe('canceled')
      } finally {
        h.cleanup()
      }
    })
  test('MCP list_node_runs forwards the actual DTO seq without changing its transport contract', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await mintSequenceRun(db, taskId, { id: 'z' })
    await mintSequenceRun(db, taskId, { id: 'a' })
    const payload = await taskNodeRunsProjection(
      withO2Closure({
        clarifyNav: o2Ports(db).collaborationReads.clarifyNav,
        db,
        nodeRunPrompts: {
          async read(row) {
            return row?.promptText ?? null
          },
          async store() {
            throw new Error('unexpected prompt write')
          },
        },
      }),
      taskId,
    )
    const operations = createBoundMcpOperationHandles({
      binding: MCP_TOOL_BINDINGS.list_node_runs,
      async invoke(_operation, input) {
        expect(input?.params).toEqual({ id: taskId })
        return { status: 200, body: payload }
      },
      observe() {},
    })
    const result = await ALL_TOOLS.find((tool) => tool.name === 'list_node_runs')!.handler(
      { id: taskId },
      {
        operations,
        get actor(): never {
          throw new Error('unexpected actor read')
        },
        async progress() {},
        signal: new AbortController().signal,
      },
    )
    expect(result).toEqual(payload)
    expect(payload.runs[0]!.seq!).toBeLessThan(payload.runs[1]!.seq!)
  })
  test('digital-employee plan inspection chooses the newest done plan run, independent of output insertion order', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db),
      path = 'plans/current.md'
    await patchTaskFixture(
      db,
      { id: taskId },
      {
        status: 'done',
        // A done workflow publishes its result through an output node. Keep the
        // plan-run freshness oracle separate from that task-boundary result.
        workflowSnapshot: JSON.stringify({
          nodes: [
            { id: DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID, kind: 'agent-single' },
            { id: 'final-result', kind: 'output', ports: [{ name: DIGITAL_EMPLOYEE_RESULT_PORT }] },
          ],
        }),
        inputs: JSON.stringify({
          [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]:
            'EXPECTED_ANALYSIS_PLAN_PATH_JSON\n' + JSON.stringify(path),
        }),
      },
    )
    await mintSequenceRun(db, taskId, { id: 'z', nodeId: DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID })
    await mintSequenceRun(db, taskId, { id: 'a', nodeId: DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID })
    await mintSequenceRun(db, taskId, { id: 'final', nodeId: 'final-result' })
    await nodeRunOutputFixture(db, [
      { nodeRunId: 'a', portName: 'analysis-plan', kind: 'document', content: path },
      { nodeRunId: 'z', portName: 'analysis-plan', kind: 'document', content: 'stale.md' },
      {
        nodeRunId: 'final',
        portName: DIGITAL_EMPLOYEE_RESULT_PORT,
        kind: 'document',
        content: '{}',
      },
    ])
    const core = composeDigitalEmployeeExecutionCore({
      appHome: '/tmp/rfc374',
      ...composeDatabaseDigitalEmployeeExecutionPorts(
        db,
        epoch2RuntimeTestPorts(db).historyRestrictions,
      ),
      resolveActor: null as never,
      resourceAuthorityFor: null as never,
      launch: null as never,
      agents: null as never,
      workflows: null as never,
      executionContracts: null as never,
    })
    expect((await core.inspect(taskId)).kind).toBe('completed')
    await mintSequenceRun(db, taskId, { id: '0', nodeId: DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID })
    expect(await core.inspect(taskId)).toMatchObject({
      kind: 'failed',
      errorCode: 'implementation-plan-path-mismatch',
    })
  })
  test('prior output uses a seq anchor and skips newer rows without captured output', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    for (const id of ['z', 'b', 'a']) await mintSequenceRun(db, taskId, { id })
    await nodeRunOutputFixture(db, {
      nodeRunId: 'z',
      portName: 'out',
      content: 'prior',
      kind: 'document',
    })
    const current = (await readNodeRunFixtures(db, { id: 'a' }))[0]!
    expect(
      (await freshestPriorRunWithOutput(new DrizzleNodeExecutionPersistence(db), current))?.id,
    ).toBe('z')
    await nodeRunOutputFixture(db, {
      nodeRunId: 'b',
      portName: 'out',
      content: 'newer',
      kind: 'document',
    })
    expect(
      (await freshestPriorRunWithOutput(new DrizzleNodeExecutionPersistence(db), current))?.id,
    ).toBe('b')
  })
  test('scheduler picks the newest surviving pending row regardless of input order', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await mintSequenceRun(db, taskId, {
      id: 'z',
      status: 'pending',
      slot: { kind: 'node', nodeId: 'n', frame },
      overrides: {
        identity: {
          shardKey: 'one',
        },
      },
    })
    await mintSequenceRun(db, taskId, {
      id: 'a',
      status: 'pending',
      slot: { kind: 'node', nodeId: 'n', frame },
      overrides: {
        identity: {
          shardKey: 'two',
        },
      },
    })
    const rows = await readNodeRunFixtures(db, { taskId }),
      persistence = createTaskExecutionPersistence(db, {
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
      })
    const result = await resolveSchedulerRunRow({
      lifecycle: persistence.nodeRuns,
      projections: persistence.nodeExecution,
      selection: persistence.selection,
      taskId,
      nodeId: 'n',
      ...frame,
      consumedUpstreamJson: '{}',
      rows: rows.map((row) => ({ ...row, generationSeq: 0 })),
      inheritReviewIteration: false,
      clearAgentOverride: false,
      trackRetryIndex: false,
      broadcastPending: null,
    })
    expect(result.nodeRunId).toBe('a')
  })
  test('T3 sees the last-minted output state, including a newer non-done row', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await patchTaskFixture(
      db,
      { id: taskId },
      {
        status: 'done',
        workflowSnapshot: JSON.stringify({
          $schema_version: 2,
          inputs: [],
          nodes: [{ id: 'out', kind: 'output', label: 'out', inputs: [] }],
          edges: [],
        }),
      },
    )
    await mintSequenceRun(db, taskId, { id: 'z', nodeId: 'out', status: 'done' })
    await mintSequenceRun(db, taskId, { id: 'a', nodeId: 'out', status: 'failed' })
    const result = await runLifecycleInvariants({
      operations: createTaskExecutionPersistence(db, {
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
      }).recoveryAdministration,
      scope: { taskId },
    })
    expect(result.openAlerts.some((alert) => alert.rule === 'T3')).toBe(true)
  })
})

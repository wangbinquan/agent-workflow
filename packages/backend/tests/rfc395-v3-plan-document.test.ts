// RFC-395 trial TF-3/4/5/6/9: plans show actionable blockers without changing their complete JSON.
import { expect, test } from 'bun:test'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { readFileSync } from 'node:fs'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { emitRunEvidence } from '@/modules/task-execution/infrastructure/migration/run/evidence'
import { runRule } from '@/modules/task-execution/infrastructure/migration/run/rule'
import { recordTaskIssues } from '@/modules/task-execution/infrastructure/migration/task/evidence'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  RowDisposition,
  SourceRow,
} from '@/platform/persistence/migration/conversion/types'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  createMigrationPlanDocument,
  parseMigrationPlanDocument,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import {
  renderEpochPlan,
  tasksToSettle,
} from '@/modules/system-operations/domain/epochSwitch/planDocument'
import { describeEpochBlock } from '@/modules/system-operations/domain/epochSwitch/remediation'
import { createEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import {
  planView,
  unfinishedTasks,
} from '@/modules/system-operations/application/epochSwitch/planner'
import { makeSwitchFixture, plannedFixture, fixtureDigest } from './rfc395-v3-switch-domain.test'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import { runSource, sourceRow, taskFacts } from './helpers/rfc395V2/runFixtures'
import { taskRow } from './helpers/rfc395V2/taskFixtures'

function executableBlock(
  id: string,
  taskId = 'interrupted-task',
  code = 'v2-run-null-nonce',
): ConversionBlock {
  return rowBlock(
    code,
    runSource(id, { task_id: taskId }),
    {
      executableTask: { taskId, status: 'interrupted' },
      reason: 'selected run lacks evidence',
      raw: { cells: { envelope_nonce: { storageClass: 'null', value: { type: 'null' } } } },
    },
    ['envelope_nonce'],
  )
}

function history(id: string, executable = false): RowDisposition {
  return {
    sourceTable: 'node_runs',
    sourceKey: encodeMigrationKey('node_runs', [canonicalValue(id)]),
    sourcePhase: 'current',
    class: 'converted',
    kind: 'history-only',
    targets: [],
    archive: null,
    rule: { id: 'task-execution/run/epoch1', version: 2 },
    history: {
      taskId: 'settled-task',
      runId: id,
      missingFields: ['envelope_nonce'],
      ...(executable
        ? {
            execution: 'executable' as const,
            executionUse: 'none' as const,
            reason: 'null-envelope-nonce-unselected' as const,
          }
        : { execution: 'retryable-history' as const }),
    },
    decision: {
      code: 'v2-run-history-only',
      detail: { codes: ['v2-run-null-nonce'], resumeRetry: 'refused' },
    },
  }
}

test('blocked plans name task counts, real acknowledgement syntax and remediation groups, then re-plan', async () => {
  const f = makeSwitchFixture()
  try {
    f.control.planBlocks = [
      executableBlock('run-a'),
      executableBlock('run-a', 'interrupted-task', 'v2-run-selected-unprovable'),
      executableBlock('run-b'),
      {
        code: 'v2-code-history-unfinished',
        scope: 'row',
        sourceTable: 'code_work_items',
        sourceKey: encodeMigrationKey('code_work_items', [canonicalValue('work')]),
        taskId: null,
        runId: null,
        missingFields: [],
        detail: { rowDigest: fixtureDigest },
        acknowledgeable: true,
      },
      {
        code: 'v3-content-missing',
        scope: 'global',
        sourceTable: null,
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: [],
        detail: null,
      },
      rowBlock('v2-source-codec', runSource('invalid-row'), { column: 'status' }, ['status']),
    ]
    f.control.plannedRestrictions = [history('old-a'), history('old-b'), history('unused', true)]
    const view = await f.app.plan({})
    const markdown = readFileSync(view.markdownPath!, 'utf8')
    const original = JSON.stringify(view.plan)
    expect(view.requiresApproval).toBe(true)
    expect(view.guidance).toContain('Run is blocked by 6 block(s).')
    expect(view.guidance.join('\n')).toContain('Tasks to settle before switching: 1.')
    expect(view.guidance).toContain(
      `db migration acknowledge ${f.operationId} --item ${view.acknowledgeable[0]!.id} --reason TEXT`,
    )
    expect(view.guidance.some((line) => line.startsWith('supply-input:'))).toBe(true)
    expect(view.guidance.some((line) => line.startsWith('repair-source:'))).toBe(true)
    expect(view.guidance.at(-1)).toBe(`Re-plan with: db migration plan ${f.operationId}`)
    expect(view.guidance.join('\n')).not.toContain('db migration run')
    expect(markdown).not.toContain('db migration run')
    expect(tasksToSettle(view.plan)).toEqual([
      {
        taskId: 'interrupted-task',
        status: 'interrupted',
        blockedRows: 2,
        codes: ['v2-run-null-nonce', 'v2-run-selected-unprovable'],
      },
    ])
    expect(markdown.indexOf('## Blocks')).toBeLessThan(markdown.indexOf('## Restrictions'))
    expect(markdown).toContain('| v2-run-null-nonce | node_runs | 2 |')
    expect(markdown).toContain('| interrupted-task | interrupted | 2 |')
    expect(markdown).toContain('| node_runs | v2-run-history-only | retryable-history | 2 |')
    expect(markdown).toContain(
      '| node_runs | v2-run-history-only | executable / null-envelope-nonce-unselected | 1 |',
    )
    expect(markdown).toContain('- node_runs(run-a): v2-run-null-nonce; missing: envelope_nonce;')
    expect(markdown).not.toContain('mk1:')
    expect(markdown).not.toContain('storageClass')
    expect(markdown.split('\n').filter((line) => line.startsWith('- node_runs('))).toHaveLength(7)
    expect(markdown).toContain('interrupted work follows interrupted recovery')
    expect(markdown).not.toContain('Failed/canceled/interrupted')
    expect(renderEpochPlan(view.plan)).toBe(markdown)
    // Crash recovery reads canonical JSON with a different insertion order. The same
    // digest must reproduce the same write-once Markdown bytes.
    expect(renderEpochPlan(JSON.parse(canonicalSchemaJson(view.plan)))).toBe(markdown)
    expect(JSON.stringify(view.plan)).toBe(original)
    expect(parseMigrationPlanDocument(readFileSync(view.jsonPath!, 'utf8'))).toEqual(view.plan)
    expect(view.plan.payload.blocks[0]!.block.detail).toHaveProperty('raw')
    await expect(
      f.app.run({ operationId: f.operationId, approve: view.plan.approvalDigest }),
    ).rejects.toThrow('plan-blocked')
    const journal = (await f.deps.journal.read(f.operationId))!
    const approved = createEpochSwitchJournal({
      ...journal.payload,
      plan: {
        ...journal.payload.plan!,
        approvedDigest: view.plan.approvalDigest,
        approvedAt: 123,
      },
    })
    const repeated = planView(approved, view.plan, f.root)
    expect(repeated.requiresApproval).toBe(false)
    expect(repeated.guidance.join('\n')).not.toContain('db migration run')
  } finally {
    f.close()
  }
})

test('unblocked plans keep material approval and PostgreSQL profile guidance', async () => {
  const f = await plannedFixture()
  try {
    expect(f.plan.guidance).toContain(
      `db migration run ${f.operationId} --approve ${f.plan.plan.approvalDigest}`,
    )
    expect(renderEpochPlan(f.plan.plan)).toContain(
      `db migration run ${f.operationId} --approve ${f.plan.plan.approvalDigest}`,
    )
    const pg = createMigrationPlanDocument({
      ...f.plan.plan.payload,
      target: {
        ...f.plan.plan.payload.target,
        provider: 'postgresql',
        location: { kind: 'postgresql-target', profileRef: 'env:TARGET_URL' },
      },
    })
    const view = planView((await f.deps.journal.read(f.operationId))!, pg, f.root)
    expect(view.guidance.join('\n')).toContain('Keep env:TARGET_URL available after activation')
    expect(view.requiresApproval).toBe(true)
  } finally {
    f.close()
  }
})

test('compact rendering keeps composite keys, escapes table separators and leaves complete evidence and digests intact', async () => {
  const f = await plannedFixture()
  try {
    const block: ConversionBlock = {
      code: 'v2-example|code',
      scope: 'row',
      sourceTable: 'example',
      sourceKey: encodeMigrationKey('example', [canonicalValue('first\npart'), canonicalValue(7)]),
      taskId: null,
      runId: null,
      missingFields: ['a\nb'],
      detail: {
        message: 'first\nsecond',
        source: { cells: { payload: { type: 'text', value: 'x'.repeat(5000) } } },
        reason: 'why'.repeat(500),
      },
    }
    const plan = createMigrationPlanDocument({
      ...f.plan.plan.payload,
      blocks: [describeEpochBlock(block)],
    })
    const before = JSON.stringify(plan)
    const markdown = renderEpochPlan(plan)
    expect(markdown).toContain('example(first part, 7)')
    expect(markdown).toContain('| v2-example\\|code | example | 1 |')
    expect(markdown).toContain('missing: a b; detail:')
    expect(markdown).not.toContain('payload')
    expect(markdown).not.toContain('x'.repeat(100))
    expect(markdown).not.toContain('\n  ')
    expect(markdown).not.toContain('mk1:')
    expect(markdown.split('\n').find((line) => line.startsWith('- example('))!.length).toBeLessThan(
      600,
    )
    expect(JSON.stringify(plan)).toBe(before)
    expect(parseMigrationPlanDocument(before)).toEqual(plan)
  } finally {
    f.close()
  }
})

test('the task-settlement hint requires an executable marker and matching task identity', () => {
  const block = executableBlock('run')
  const item = describeEpochBlock(block)
  expect(item.remediation.action).toBe('repair-source')
  expect(item.remediation.message).toContain(
    'is still interrupted; finish or cancel it in the current version, then re-plan',
  )
  expect(item.remediation.message).toContain('history-only')
  for (const detail of [
    null,
    { executableTask: { taskId: 'other-task', status: 'running' } },
    { executableTask: { taskId: block.taskId, status: 'failed' } },
    { executableTask: { taskId: block.taskId, status: 'unknown' } },
  ])
    expect(describeEpochBlock({ ...block, detail }).remediation.message).not.toContain(
      'finish or cancel',
    )
})

async function evidenceContext(row: SourceRow) {
  const f = makeSwitchFixture()
  const source = await f.deps.source.discover({
    location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
    emptyTables: [],
    operationRoot: f.root,
  })
  const target = targetRegistryView(persistenceSchema)
  const collector = createUnitCollector({
    rule: runRule,
    sourceRows: [row],
    sourceVersion: source.preflight.sourceVersion,
    sourceContract: fixtureDigest,
    target,
    topology: target.tables.map((table) => table.id),
  })
  const blocks: ConversionBlock[] = []
  const dispositions: Omit<RowDisposition, 'rule'>[] = []
  const ctx: RuleContext = {
    sourceVersion: source.preflight.sourceVersion,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_source_fixture',
    preflight: { ...source.preflight, contract: frozenEpoch1Contract },
    planTime: 123,
    target,
    lookup() {
      throw new Error('evidence does not query lookups')
    },
    ids: {
      child() {
        throw new Error('evidence does not allocate ids')
      },
    },
    content: emptyV2Content,
    out: {
      ...collector.out,
      block(block) {
        blocks.push(block)
        collector.out.block(block)
      },
      exception(disposition) {
        dispositions.push(disposition)
        collector.out.exception(disposition)
      },
    },
  }
  return { ctx, blocks, dispositions, close: () => f.close() }
}

test('run evidence marks only executable gating, retaining retryable history and unused-nonce exceptions', async () => {
  const decision = {
    code: 'v2-run-null-nonce',
    unprovable: true,
    missingFields: ['envelope_nonce'],
    detail: { missing: 'nonce' },
  }
  for (const status of [
    'pending',
    'running',
    'awaiting_human',
    'awaiting_review',
    'interrupted',
    'failed',
    'canceled',
    'done',
  ]) {
    const row = runSource('run', { task_id: 'task', envelope_nonce: null })
    const f = await evidenceContext(row)
    try {
      const facts = taskFacts('task', status)
      emitRunEvidence(row, facts, [decision], null, f.ctx)
      if (facts.execution === 'executable') {
        expect(f.blocks).toMatchObject([
          { detail: { missing: 'nonce', executableTask: { taskId: 'task', status } } },
        ])
        expect(f.dispositions).toEqual([])
      } else {
        expect(f.blocks).toEqual([])
        expect(f.dispositions).toMatchObject([
          { kind: 'history-only', history: { execution: facts.execution } },
        ])
      }
    } finally {
      f.close()
    }
  }
  const row = runSource('unused', { task_id: 'task', envelope_nonce: null })
  const f = await evidenceContext(row)
  try {
    emitRunEvidence(row, taskFacts('task', 'interrupted'), [decision], null, f.ctx, true)
    expect(f.blocks).toEqual([])
    expect(f.dispositions).toMatchObject([
      {
        kind: 'history-only',
        history: {
          execution: 'executable',
          executionUse: 'none',
          reason: 'null-envelope-nonce-unselected',
        },
      },
    ])
  } finally {
    f.close()
  }
})

test('task evidence never marks alwaysBlock issues as resolvable by settling a task', async () => {
  for (const status of ['interrupted', 'failed', 'done']) {
    const row = sourceRow('tasks', taskRow('task', { status }))
    const f = await evidenceContext(row)
    try {
      recordTaskIssues(
        row,
        taskFacts('task', status),
        [
          {
            code: 'v2-task-gated',
            missingFields: ['workspace'],
            detail: { reason: 'missing workspace' },
          },
          {
            code: 'v2-task-always',
            missingFields: ['subject'],
            detail: { reason: 'invalid subject' },
            alwaysBlock: true,
          },
        ],
        [],
        f.ctx,
      )
      expect(f.blocks.find((block) => block.code === 'v2-task-always')!.detail).toEqual({
        reason: 'invalid subject',
      })
      expect(f.blocks.find((block) => block.code === 'v2-task-gated')?.detail).toEqual(
        status === 'interrupted'
          ? { reason: 'missing workspace', executableTask: { taskId: 'task', status } }
          : undefined,
      )
      expect(f.dispositions).toEqual([])
    } finally {
      f.close()
    }
  }
})

test('unfinished inventory follows the converter across chunks and rejects unknown statuses', async () => {
  const f = makeSwitchFixture()
  try {
    const source = await f.deps.source.discover({
      location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      emptyTables: [],
      operationRoot: f.root,
    })
    expect(await unfinishedTasks(source)).toEqual([])
    const statuses = [
      'pending',
      'running',
      'awaiting_human',
      'awaiting_review',
      'interrupted',
      'interrupted',
      'failed',
      'canceled',
      'done',
    ]
    const reader = {
      ...source.reader,
      async readChunk(_table: string, after: readonly unknown[] | null) {
        const index = after ? Number((after[0] as { value: string }).value) + 1 : 0
        const batch = statuses.slice(index, index + 3)
        const rows = batch.map((status, offset) => ({
          key: [canonicalValue(index + offset)],
          values: [canonicalValue(status)],
        }))
        return {
          version: 1 as const,
          sourceVersion: source.preflight.sourceVersion,
          table: 'tasks',
          migrationKey: ['id'],
          afterKey: null,
          firstKey: rows[0]?.key ?? null,
          lastKey: rows.at(-1)?.key ?? null,
          rows,
          decodedRows: batch.map((status) => ({ status })),
          sourceDigest: fixtureDigest,
        }
      },
    }
    const withTasks = {
      ...source,
      reader,
      preflight: {
        ...source.preflight,
        tables: [
          {
            table: 'tasks',
            physicalTable: 'tasks',
            rows: statuses.length,
            disposition: 'converted' as const,
            destination: { kind: 'business' as const, tables: ['tasks'] },
            reason: 'fixture',
          },
        ],
      },
    }
    expect(await unfinishedTasks(withTasks)).toEqual([
      { status: 'awaiting_human', count: 1 },
      { status: 'awaiting_review', count: 1 },
      { status: 'interrupted', count: 2 },
      { status: 'pending', count: 1 },
      { status: 'running', count: 1 },
    ])
    statuses.push('completed')
    await expect(unfinishedTasks(withTasks)).rejects.toThrow('v2-unknown-task-status')
  } finally {
    f.close()
  }
})

test('discovery names all open operations with status and continuation/discard commands', async () => {
  const f = await plannedFixture()
  try {
    const journal = (await f.deps.journal.read(f.operationId))!
    const second = createEpochSwitchJournal({
      ...journal.payload,
      operationId: 'dbm_e2_second_operation',
      status: 'failed',
    })
    const completed = createEpochSwitchJournal({
      ...journal.payload,
      operationId: 'dbm_e2_completed',
      status: 'completed',
    })
    f.deps.journal.list = async () => [journal, second, completed]
    const error = await f.app.plan({}).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('v3-another-operation-active')
    for (const item of [journal, second]) {
      expect(message).toContain(
        `${item.payload.operationId} (${item.payload.status}, ${item.payload.phase})`,
      )
      expect(message).toContain(`db migration plan ${item.payload.operationId}`)
      expect(message).toContain(`db migration discard ${item.payload.operationId} --confirm`)
    }
    expect(message).not.toContain('dbm_e2_completed')
    expect(message.indexOf('dbm_e2_second_operation')).toBeLessThan(message.indexOf(f.operationId))
    expect((await f.app.plan({ operationId: f.operationId })).operationId).toBe(f.operationId)
  } finally {
    f.close()
  }
})

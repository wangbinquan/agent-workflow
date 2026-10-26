// RFC-395 phase 2: execution-use, codec, writer and allocation regressions.
import { expect, test } from 'bun:test'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { frozenRunDefinition } from '@/modules/task-execution/infrastructure/migration/run/definitions'
import { computeLegacySelections } from '@/modules/task-execution/infrastructure/migration/run/selection'
import { deriveRunIdentities } from '@/modules/task-execution/infrastructure/migration/run/identity'
import { extractWriterFacts } from '@/modules/task-execution/infrastructure/migration/run/writers'
import { oracleRow } from '@/modules/task-execution/infrastructure/migration/run/source'
import {
  allocationBase,
  emitAllocationHighWater,
} from '@/modules/task-execution/infrastructure/migration/run/allocations'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  runSource,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
  ordinaryDefinition,
} from './helpers/rfc395V2/runFixtures'

const fanout = {
  $schema_version: 7,
  nodes: [
    { id: 'w', kind: 'wrapper-fanout', nodeIds: ['shard', 'a', 'b'], shardSourcePort: 'items' },
    { id: 'shard', kind: 'script' },
    { id: 'a', kind: 'agent-single', agentName: 'same-selector' },
    { id: 'b', kind: 'agent-single', agentName: 'same-selector' },
  ],
  edges: [
    {
      id: 'fanout-input',
      source: { nodeId: 'w', portName: 'items' },
      target: { nodeId: 'shard', portName: 'items' },
      boundary: 'wrapper-input',
    },
    {
      id: 'fanout-aggregate',
      source: { nodeId: 'shard', portName: 'out' },
      target: { nodeId: 'a', portName: 'in' },
    },
  ],
}

test('T/N-11 aggregator is the persisted direct-child writer, no writer is null, conflicting writers stay unproved', () => {
  const wrapper = runSource('wrapper', { node_id: 'w' })
  const mint = (id: string, node: string) =>
    runSource(id, {
      node_id: node,
      rerun_cause: 'fanout-aggregator',
      parent_node_run_id: 'wrapper',
      container_run_id: 'wrapper',
    })
  const frozen = (rows: ReturnType<typeof runSource>[]) =>
    frozenRunDefinition(JSON.stringify(fanout), rows)
  expect(frozen([wrapper]).fanouts[0]!.aggregatorNodeId).toBeNull()
  const proved = frozen([wrapper, mint('a-run', 'a')])
  expect(proved.missingFacts).toEqual([])
  expect(proved.fanouts[0]).toMatchObject({
    aggregatorNodeId: 'a',
    perShardNodeIds: ['shard'],
    sharedNodeIds: ['b'],
  })
  expect(proved.fanouts[0]!.evidence.join(' ')).toContain('a-run')
  for (const rows of [
    [wrapper, mint('a-run', 'a'), mint('b-run', 'b')],
    [
      wrapper,
      runSource('bad', {
        node_id: 'a',
        rerun_cause: 'fanout-aggregator',
        parent_node_run_id: 'wrapper',
        shard_key: 'not-null',
      }),
    ],
    [
      wrapper,
      runSource('bad', {
        node_id: 'a',
        rerun_cause: 'fanout-aggregator',
        parent_node_run_id: 'missing',
      }),
    ],
  ]) {
    expect(frozen(rows).fanouts).toEqual([])
    expect(frozen(rows).missingFacts).toContain('fanout.writer-conflict:w')
  }
})

test('T/N-9 a selection mismatch marks every slot member without slotless noise', async () => {
  const task = taskFacts()
  const rows = [
    runSource('parent', { node_id: '__commit_push__', commit_push_json: '{}', seq: 1 }),
    runSource('old-session', { node_id: '__commit_push__', parent_node_run_id: 'parent', seq: 2 }),
    runSource('new-session', { node_id: '__commit_push__', parent_node_run_id: 'parent', seq: 3 }),
    runSource('unknown', { node_id: 'missing', seq: 4 }),
  ]
  const definition = frozenRunDefinition('{"$schema_version":7,"nodes":[],"edges":[]}')
  const projected = rows.map((row) =>
    oracleRow(row, Number(row.values.seq), {
      runId: String(row.values.id),
      taskId: 'task',
      containerRunId: null,
      scopePath: '',
      iteration: 0,
      quality: 'recorded',
    }),
  )
  const identities = deriveRunIdentities(
    projected,
    task,
    definition,
    extractWriterFacts(task, definition, rows, {
      assignments: [],
      preparations: [],
      gateStatus: null,
      dwStateJson: null,
    }),
  )
  const result = await computeLegacySelections({
    task,
    rows: projected,
    identities,
    historyOnly: new Set(),
  })
  expect(
    result.mismatches
      .filter((row) => row.code === 'v2-run-selection-mismatch')
      .map((row) => row.runId)
      .sort(),
  ).toEqual(['new-session', 'old-session'])
  expect(result.mismatches.some((row) => row.runId === 'unknown')).toBe(false)
})

test('T/N-9 allocator uses pre-upgrade evidence and records the maximum actually used', () => {
  const records: MigrationRecord[] = []
  const identity = (value: string) => [
    {
      name: 'seq',
      table: 'node_run_seq_allocations',
      column: 'seq',
      value,
      isCalled: true,
      increment: '1',
    },
  ]
  const ctx = {
    preflight: { identityHighWater: identity('700'), identityEvidence: 'captured' },
    preUpgradePreflight: { identityHighWater: identity('900'), identityEvidence: 'captured' },
    out: { record: (record: MigrationRecord) => records.push(record) },
  } as unknown as RuleContext
  const plan = { observedHighWater: 800, allocationCount: 1 }
  expect(allocationBase(plan, ctx)).toBe(900)
  emitAllocationHighWater(plan, 900, ctx)
  expect(records).toMatchObject([{ kind: 'identity-high-water', value: '901', basis: 'both' }])
  expect(
    allocationBase(
      { observedHighWater: Number.MAX_SAFE_INTEGER, allocationCount: 0 },
      { ...ctx, preUpgradePreflight: { ...ctx.preflight, identityHighWater: [] } },
    ),
  ).toBe(Number.MAX_SAFE_INTEGER)
})

describeV2Providers('RFC-395 phase 2 NodeRun repairs', (h) => {
  for (const empty of [false, true])
    test(`deleted task allocations retain high water, empty task set=${empty}`, async () => {
      await h.install()
      const task = taskFacts('live', 'running')
      if (!empty) {
        await writeTask(h, task)
        await h.write('node_runs', [
          runValues('a', { task_id: 'live', seq: 1 }),
          runValues('z', { task_id: 'live', seq: null }),
        ])
      }
      await h.write('node_run_seq_allocations', [
        { seq: 700, task_id: 'deleted', node_run_id: 'deleted-run', allocated_at: 1 },
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: empty ? [] : [task], taskMounts: empty ? [] : [taskMounts('live')] },
      })
      try {
        const sink = new V2MemorySink(),
          summary = await runConversion(input, sink)
        expect(summary.blocks).toEqual([])
        const units = [...sink.units.values()]
        expect(
          units
            .flatMap((unit) => unit.dispositions)
            .filter((row) => row.decision?.code === 'v2-run-deleted-task-allocation'),
        ).toHaveLength(1)
        expect(units.flatMap((unit) => unit.archives)).toHaveLength(1)
        expect(summary.records.filter((row) => row.kind === 'identity-high-water')).toMatchObject([
          { value: empty ? '700' : '701' },
        ])
        expect(sink.rows('node_run_seq_allocations').map((row) => row.seq)).toEqual(
          empty ? [] : [701],
        )
      } finally {
        await input.source.close()
      }
    }, 180_000)

  for (const status of ['running', 'awaiting_human', 'interrupted'])
    test(`${status}: unselected NULL nonce gets executionUse none; current survives`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task)
      await h.write('node_runs', [
        runValues('old', { seq: 1, envelope_nonce: null }),
        runValues('current', { seq: 2 }),
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink(),
          summary = await runConversion(input, sink)
        expect(summary.blocks).toEqual([])
        expect(summary.historyOnly).toHaveLength(1)
        expect(summary.historyOnly[0]!.history).toEqual({
          taskId: 'task',
          runId: 'old',
          execution: 'executable',
          executionUse: 'none',
          reason: 'null-envelope-nonce-unselected',
          missingFields: ['envelope_nonce'],
        })
        expect(sink.rows('node_runs').find((row) => row.id === 'old')!.record_mode).toBe(
          'history-only',
        )
        expect(sink.rows('node_runs').find((row) => row.id === 'current')!.record_mode).toBe(
          'executable',
        )
        expect(sink.rows('node_run_selections')[0]!.selected_run_id).toBe('current')
      } finally {
        await input.source.close()
      }
    }, 180_000)

  for (const oldStatus of ['canceled', 'interrupted', 'pending'])
    test(`${oldStatus}: a superseded wrapper is not resumed and its NULL nonce is history-only`, async () => {
      await h.install()
      const task = taskFacts('task', 'interrupted')
      await writeTask(h, task, {
        $schema_version: 7,
        nodes: [{ id: 'w', kind: 'wrapper-loop', nodeIds: [] }],
        edges: [],
      })
      await h.write('node_runs', [
        runValues('old', {
          node_id: 'w',
          seq: 1,
          status: oldStatus,
          envelope_nonce: null,
          rerun_cause: 'wrapper-init',
        }),
        runValues('current', { node_id: 'w', seq: 2, rerun_cause: 'wrapper-init' }),
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink(),
          summary = await runConversion(input, sink)
        expect(summary.blocks).toEqual([])
        expect(summary.historyOnly).toHaveLength(1)
        expect(summary.historyOnly[0]!.history).toMatchObject({
          runId: 'old',
          executionUse: 'none',
        })
        expect(sink.rows('node_run_selections')[0]!.selected_run_id).toBe('current')
      } finally {
        await input.source.close()
      }
    }, 180_000)

  test('an unselected repo-prep attempt read by resume still blocks on a NULL nonce', async () => {
    await h.install()
    const task = taskFacts('task', 'interrupted')
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('selected', { node_id: '__repo_prep__', seq: 1, retry_index: 9 }),
      runValues('resume', {
        node_id: '__repo_prep__',
        seq: 2,
        retry_index: 0,
        status: 'failed',
        envelope_nonce: null,
      }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(
        summary.blocks.some((row) => row.runId === 'resume' && row.code === 'v2-run-null-nonce'),
      ).toBe(true)
      expect(summary.historyOnly).toEqual([])
      expect(sink.rows('node_run_selections')[0]!.selected_run_id).toBe('selected')
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('the turns driver adopts an unselected pending host, so its NULL nonce still blocks', async () => {
    await h.install()
    const task = taskFacts('task', 'running', {
      subjectKind: 'workgroup',
      engineKind: 'workgroup-turns',
    })
    await writeTask(h, task)
    await h.write('workgroup_task_state', [
      { task_id: 'task', gate_status: 'idle', updated_at: 100 },
    ])
    await h.write('node_runs', [
      runValues('pending', {
        node_id: '__wg_leader__',
        seq: 1,
        status: 'pending',
        envelope_nonce: null,
        rerun_cause: 'wg-leader-round',
      }),
      runValues('current', { node_id: '__wg_leader__', seq: 2, rerun_cause: 'wg-leader-round' }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(
        summary.blocks.some((row) => row.runId === 'pending' && row.code === 'v2-run-null-nonce'),
      ).toBe(true)
      expect(summary.historyOnly).toEqual([])
      expect(sink.rows('node_run_selections')[0]!.selected_run_id).toBe('current')
    } finally {
      await input.source.close()
    }
  }, 180_000)

  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`${status}: all checkpoint JSON takeovers receive D4 decisions`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task)
      const columns = [
        'pre_snapshot_repos_json',
        'iso_base_snapshot_repos_json',
        'iso_node_tree_repos_json',
        'iso_submodules_json',
        'iso_submodules_repos_json',
      ]
      await h.write(
        'node_runs',
        columns.map((column, index) => runValues(column, { seq: index + 1, [column]: '{broken' })),
      )
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink(),
          summary = await runConversion(input, sink)
        expect(
          summary.blocks.some(
            (row) => row.code === 'v2-source-codec' || row.code === 'v2-undecided-source-codec',
          ),
        ).toBe(false)
        expect(summary.blocks.length > 0).toBe(status === 'running')
        expect(summary.historyOnly).toHaveLength(status === 'running' ? 0 : columns.length)
        if (status !== 'running') {
          expect(summary.historyOnly.flatMap((row) => row.codecColumns ?? []).sort()).toEqual(
            [...columns].sort(),
          )
          expect(sink.rows('node_runs')).toHaveLength(columns.length)
          expect(sink.rows('node_run_repo_checkpoints')).toEqual([])
        }
      } finally {
        await input.source.close()
      }
    }, 180_000)

  for (const status of ['running', 'failed', 'done'])
    for (const conflict of [false, true])
      test(`${status}/fanout conflict=${conflict}: persisted mint facts drive actual conversion`, async () => {
        await h.install()
        const task = taskFacts('task', status)
        await writeTask(h, task, fanout)
        await h.write('node_runs', [
          runValues('wrapper', { node_id: 'w', seq: 1, rerun_cause: 'wrapper-init' }),
          runValues('a-run', {
            node_id: 'a',
            seq: 2,
            parent_node_run_id: 'wrapper',
            container_run_id: 'wrapper',
            rerun_cause: 'fanout-aggregator',
          }),
          ...(conflict
            ? [
                runValues('b-run', {
                  node_id: 'b',
                  seq: 3,
                  parent_node_run_id: 'wrapper',
                  container_run_id: 'wrapper',
                  rerun_cause: 'fanout-aggregator',
                }),
              ]
            : []),
        ])
        const input = await h.input([conversion], {
          fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
        })
        try {
          const sink = new V2MemorySink(),
            summary = await runConversion(input, sink)
          expect(summary.blocks.length > 0).toBe(conflict && status === 'running')
          expect(summary.historyOnly).toHaveLength(conflict && status !== 'running' ? 2 : 0)
          if (!conflict) {
            expect(sink.rows('node_runs').find((row) => row.id === 'a-run')!.record_mode).toBe(
              'executable',
            )
            expect(
              String(sink.rows('node_runs').find((row) => row.id === 'a-run')!.slot_key),
            ).toContain('aggregator')
          }
        } finally {
          await input.source.close()
        }
      }, 180_000)

  test('empty submodule JSON is an explicit preserved empty string takeover', async () => {
    await h.install()
    const task = taskFacts('task', 'running')
    await writeTask(h, task)
    await h.write('node_runs', [runValues('r', { iso_submodules_json: '' })])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      expect(sink.rows('node_run_repo_checkpoints')[0]!.submodules).toBe('""')
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .find((row) => row.decision?.code === 'v2-run-codec-takeover')!.codecColumns,
      ).toEqual(['iso_submodules_json'])
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('unreadable snapshot retains recorded container and scope bytes', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task, '{bad')
    await h.write('node_runs', [
      runValues('wrapper', { seq: 1 }),
      runValues('recorded', { seq: 2, container_run_id: 'wrapper', scope_path: 'original:7' }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      expect(sink.rows('node_runs').find((row) => row.id === 'recorded')).toMatchObject({
        container_run_id: 'wrapper',
        scope_path: 'original:7',
        record_mode: 'history-only',
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('large payloads use target references and run units never enumerate every task', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task, ordinaryDefinition)
    const payload = JSON.stringify({ large: 'unique-payload-'.repeat(10000) })
    await h.write('node_runs', [
      runValues('r', { prompt_text: payload, inventory_snapshot_json: payload }),
    ])
    const checked = {
      ...conversion,
      rules: conversion.rules.map((rule) =>
        rule.ref.id !== 'task-execution/run/epoch1'
          ? rule
          : {
              ...rule,
              convert: (unit: Parameters<typeof rule.convert>[0], ctx: RuleContext) =>
                rule.convert(unit, {
                  ...ctx,
                  lookup(key) {
                    const reader = ctx.lookup(key)
                    return key.id === TASK_FACTS.id
                      ? {
                          ...reader,
                          entries() {
                            throw new Error('per-task full scan')
                          },
                        }
                      : reader
                  },
                }),
            },
      ),
    }
    const input = await h.input([checked], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      const evidence = Buffer.from(
        sink.rows('execution_legacy_evidence')[0]!.content_inline_bytes as Uint8Array,
      ).toString()
      expect(evidence).not.toContain('unique-payload-')
      expect(JSON.parse(evidence)).toMatchObject({
        sourceValues: { runtime_inventory_json: { type: 'null' } },
        sourceReferences: { inventory_snapshot_json: { table: 'node_run_configs', runId: 'r' } },
      })
      expect(JSON.parse(evidence).sourceReferences.runtime_inventory_json).toBeUndefined()
      expect(sink.rows('node_run_configs')[0]!.inventory_snapshot_json).toBe(payload)
      expect(
        Buffer.from(sink.rows('node_run_configs')[0]!.prompt_inline_bytes as Uint8Array).toString(),
      ).toBe(payload)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})

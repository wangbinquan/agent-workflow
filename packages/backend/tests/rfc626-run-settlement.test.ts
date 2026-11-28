// RFC-626 F2 (design §3.2.1-§3.2.2, §3.2.5, §7 "结束任务"): one frozen database per "cannot be
// proved" run code (T0 blocks.md §1.5, emission point #46), converted by the real engine.
// - operator: the run still blocks, with the `executableTask` detail it always had;
// - automatic: discovery ends the task (it is in the plan's `settlements`), the conversion proper
//   never reaches `blockExecutable`, and the very same run rows are then recorded as history-only
//   with no block — the existing "task cannot continue" path, which the rule did not change.
// Locks the switch of `run/evidence.ts` from `block` to `blockExecutable` and the `settles`
// declaration of the run rule.
import { expect, test } from 'bun:test'
import type {
  DecodedSourceRow,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { describeV2Providers, type V2Harness } from './helpers/rfc395V2Harness'
import { overrideSourceValues } from './helpers/rfc395V2/sourceOverride'
import {
  ordinaryDefinition,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'
import {
  convertRuns,
  UNPROVABLE_RUN_CODES,
  type RunConversionResult,
} from './helpers/rfc626RunConversion'

interface UnprovableCase {
  readonly snapshot?: unknown
  readonly mounts?: readonly string[]
  readonly runs: readonly DecodedSourceRow[]
  readonly source?: (h: V2Harness) => Promise<VersionedSourceReader>
}
/** Fixture shapes taken from the RFC-395 run tests that prove each code in operator mode. */
const CASES: Record<(typeof UNPROVABLE_RUN_CODES)[number], UnprovableCase> = {
  'v2-run-frame-unresolved': { snapshot: '{bad', runs: [runValues('run')] },
  'v2-run-identity-unprovable': { runs: [runValues('run', { node_id: 'missing' })] },
  'v2-run-container-unprovable': {
    runs: [runValues('run')],
    source: async (h) =>
      overrideSourceValues(await h.sourceHarness.source(), 'node_runs', (row) => ({
        ...row,
        container_run_id: 'missing',
      })),
  },
  'v2-run-null-nonce': { runs: [runValues('run', { envelope_nonce: null })] },
  'v2-run-writer-user-node-conflict': {
    snapshot: { $schema_version: 7, nodes: [{ id: '__commit_push__', kind: 'script' }], edges: [] },
    runs: [runValues('run', { node_id: '__commit_push__', commit_push_json: '{}' })],
  },
  'v2-run-checkpoint-malformed': {
    runs: [runValues('run', { pre_snapshot_repos_json: '{broken' })],
  },
  'v2-run-checkpoint-conflict': {
    runs: [runValues('run', { pre_snapshot: 'x', pre_snapshot_repos_json: '{"":"y"}' })],
  },
  'v2-run-checkpoint-scalar-unmapped': {
    mounts: ['a', 'b'],
    runs: [runValues('run', { pre_snapshot: 'root' })],
  },
  'v2-run-checkpoint-duplicate-key': {
    mounts: ['a', 'b'],
    runs: [runValues('run', { pre_snapshot_repos_json: '{"a":"x","a":"y"}' })],
  },
  'v2-run-checkpoint-key-unmapped': {
    mounts: ['a', 'b'],
    runs: [runValues('run', { iso_node_tree_repos_json: '{"missing":"tree"}' })],
  },
  'node-tree-lost-by-known-defect': {
    mounts: ['member'],
    runs: [
      runValues('run', {
        merge_state: 'isolating',
        pre_snapshot: '',
        iso_base_snapshot: 'base',
        iso_worktree_path: '/iso',
      }),
    ],
  },
  'v2-run-input-producer-missing': {
    runs: [runValues('run', { consumed_upstream_runs_json: '{"n":"missing"}' })],
  },
  'v2-run-selection-mismatch': {
    snapshot: { $schema_version: 7, nodes: [], edges: [] },
    runs: [
      runValues('parent', { node_id: '__commit_push__', commit_push_json: '{}', seq: 1 }),
      runValues('old-session', {
        node_id: '__commit_push__',
        parent_node_run_id: 'parent',
        seq: 2,
      }),
      runValues('new-session', {
        node_id: '__commit_push__',
        parent_node_run_id: 'parent',
        seq: 3,
      }),
    ],
  },
  // A selected run that is itself unprovable: the only run of its slot, with a NULL nonce.
  'v2-run-selected-unprovable': { runs: [runValues('run', { envelope_nonce: null })] },
}

async function seed(h: V2Harness, status: string, spec: UnprovableCase) {
  await h.install()
  const task = taskFacts('task', status)
  await writeTask(h, task, spec.snapshot ?? ordinaryDefinition)
  await h.write('node_runs', [...spec.runs])
  return {
    tasks: [task],
    mounts: [taskMounts('task', spec.mounts ?? [''])],
    ...(spec.source ? { source: () => spec.source!(h) } : {}),
  }
}
const restrictions = (result: RunConversionResult) =>
  result.summary.historyOnly.filter((disposition) => disposition.sourceTable === 'node_runs')
const restrictedCodes = (result: RunConversionResult) =>
  restrictions(result).flatMap(
    (disposition) => (disposition.decision?.detail as { codes: string[] }).codes,
  )

describeV2Providers('RFC-626 F2 unprovable runs end their unfinished task', (h) => {
  for (const code of UNPROVABLE_RUN_CODES)
    test(`${code}: operator blocks; automatic ends the task, then records the run as history`, async () => {
      const spec = CASES[code]
      const options = await seed(h, 'running', spec)

      const manual = await convertRuns(h, options)
      expect(manual.plan.resolution).toBeUndefined()
      expect(manual.plan.settlements).toBeUndefined()
      expect(manual.summary.resolutions).toBeUndefined()
      const blocked = manual.summary.blocks.filter((block) => block.code === code)
      expect(blocked.length).toBeGreaterThan(0)
      for (const block of blocked)
        expect(block).toMatchObject({
          scope: 'row',
          sourceTable: 'node_runs',
          taskId: 'task',
          detail: { executableTask: { taskId: 'task', status: 'running' } },
        })
      expect(manual.calls.every((call) => call.phase === 'convert')).toBe(true)
      expect(manual.calls.map((call) => call.code)).toContain(code)

      const automatic = await convertRuns(h, { ...options, resolution: 'automatic' })
      expect(automatic.plan.resolution).toBe('automatic')
      expect(automatic.plan.settlements).toHaveLength(1)
      const settlement = automatic.plan.settlements![0]!
      expect(settlement).toMatchObject({
        taskId: 'task',
        cause: 'unprovable-records',
        originalStatus: 'running',
        parentTaskId: null,
      })
      expect(settlement.blockCodes).toContain(code)
      expect<readonly string[]>([...settlement.blockCodes].sort()).toEqual(settlement.blockCodes)
      // Discovery reached blockExecutable; the conversion proper never did.
      expect(automatic.calls.filter((call) => call.phase === 'convert')).toEqual([])
      expect(
        automatic.calls.filter((call) => call.phase === 'discover').map((call) => call.code),
      ).toContain(code)
      expect(automatic.summary.blocks).toEqual([])
      expect(automatic.summary.resolutions?.settledTasks).toEqual(automatic.plan.settlements)
      // The same rows now take the rule's existing path for a task that cannot continue.
      expect(restrictions(automatic).length).toBeGreaterThan(0)
      for (const disposition of restrictions(automatic))
        expect(disposition.history).toMatchObject({
          taskId: 'task',
          execution: 'retryable-history',
        })
      expect(restrictedCodes(automatic)).toContain(code)
      for (const disposition of restrictions(automatic))
        expect(
          automatic.sink.rows('node_runs').find((row) => row.id === disposition.history!.runId),
        ).toMatchObject({ record_mode: 'history-only' })
    }, 180_000)

  // `h.install()` gives each test its own database; one seed per test.
  for (const status of ['failed', 'canceled', 'done'])
    test(`${status}: a task that can no longer continue is not ended; its unprovable runs stay history-only`, async () => {
      const options = await seed(h, status, CASES['v2-run-null-nonce'])
      for (const resolution of [undefined, 'automatic'] as const) {
        const result = await convertRuns(h, {
          ...options,
          ...(resolution ? { resolution } : {}),
        })
        expect(result.summary.blocks).toEqual([])
        expect(result.calls).toEqual([])
        expect(result.plan.settlements).toEqual(resolution ? [] : undefined)
        expect(restrictedCodes(result)).toContain('v2-run-null-nonce')
      }
    }, 180_000)

  for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted']) {
    test(`${status}: an unfinished task whose runs are all provable is not ended`, async () => {
      const options = await seed(h, status, { runs: [runValues('run')] })
      const result = await convertRuns(h, { ...options, resolution: 'automatic' })
      expect(result.plan.settlements).toEqual([])
      expect(result.calls).toEqual([])
      expect(result.summary.blocks).toEqual([])
      expect(result.summary.historyOnly).toEqual([])
      expect(result.sink.rows('node_runs')).toMatchObject([
        { id: 'run', record_mode: 'executable' },
      ])
    }, 180_000)

    test(`${status}: the ended task records its original status`, async () => {
      const options = await seed(h, status, CASES['v2-run-null-nonce'])
      const result = await convertRuns(h, { ...options, resolution: 'automatic' })
      expect(result.plan.settlements).toMatchObject([
        { taskId: 'task', cause: 'unprovable-records', originalStatus: status },
      ])
      expect(result.summary.blocks).toEqual([])
      expect(restrictedCodes(result)).toContain('v2-run-null-nonce')
    }, 180_000)
  }
})

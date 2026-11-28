// RFC-626 F2 (design §3.2.1, §3.2.2): the run rule converted in either resolution through the
// real engine (`prepareConversion` → `run`). Task facts are read from the staged `tasks` rows and
// a test settler only rewrites a task's status, so ending a task changes what the run rule sees
// the way the real settlement does, without depending on the task module's settlers.
import { conversion as runs } from '@/modules/task-execution/infrastructure/migration/run'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  executionClass,
  type TaskFacts,
  type TaskMountFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ContentInventory } from '@/platform/persistence/migration/conversion/content'
import type {
  ConversionResolution,
  MigrationRecord,
  RowDisposition,
} from '@/platform/persistence/migration/conversion/types'
import type {
  SourcePreflight,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { decodeLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { V2Harness } from './rfc395V2Harness'
import { V2MemorySink } from './rfc395V2MemorySink'
import { taskMounts } from './rfc395V2/runFixtures'

/** Every code a run of an unfinished task can block with (T0 blocks.md §1.5, emission point #46). */
export const UNPROVABLE_RUN_CODES = [
  'v2-run-frame-unresolved',
  'v2-run-identity-unprovable',
  'v2-run-container-unprovable',
  'v2-run-null-nonce',
  'v2-run-writer-user-node-conflict',
  'v2-run-checkpoint-malformed',
  'v2-run-checkpoint-conflict',
  'v2-run-checkpoint-scalar-unmapped',
  'v2-run-checkpoint-duplicate-key',
  'v2-run-checkpoint-key-unmapped',
  'node-tree-lost-by-known-defect',
  'v2-run-input-producer-missing',
  'v2-run-selection-mismatch',
  'v2-run-selected-unprovable',
] as const

/** TaskFacts as fixed by the test, except that status and execution follow the staged row. */
export function stagedTaskFacts(tasks: readonly TaskFacts[]): LookupBuilder<TaskFacts> {
  return {
    key: TASK_FACTS,
    sources: ['tasks'],
    build(staged, put) {
      for (const task of tasks) {
        const row = staged.group('tasks', 'id', task.taskId)[0]
        const status = typeof row?.values.status === 'string' ? row.values.status : task.status
        put(task.taskId, { ...task, status, execution: executionClass(status) })
      }
    },
  }
}

/** Ends a task by canceling its `tasks` row; nothing else is rewritten. */
export function cancelingSettlement(tasks: readonly TaskFacts[]): ConversionContribution {
  return {
    rules: [],
    validators: [],
    lookups: [stagedTaskFacts(tasks)],
    settlement: {
      settlers: [
        {
          tables: [{ table: 'tasks', taskColumn: 'id' }],
          settle: (rows) =>
            (rows.get('tasks') ?? []).map((row) => ({
              table: 'tasks',
              key: row.encodedKey,
              values: { ...row.values, status: 'canceled' },
            })),
        },
      ],
    },
  }
}

export interface BlockExecutableCall {
  readonly phase: 'discover' | 'convert'
  readonly taskId: string
  readonly status: string
  readonly code: string
}

/**
 * The run contribution with every `blockExecutable` the run rule makes recorded. Calls made while
 * `prepareConversion` runs are discovery; calls made by `run` are the conversion proper.
 */
function observedRuns(
  calls: BlockExecutableCall[],
  phase: () => BlockExecutableCall['phase'],
): ConversionContribution {
  return {
    ...runs,
    rules: runs.rules.map(
      (rule): ConversionRule => ({
        ...rule,
        convert: (unit, ctx) =>
          rule.convert(unit, {
            ...ctx,
            out: {
              ...ctx.out,
              blockExecutable(task, block) {
                calls.push({ phase: phase(), ...task, code: block.code })
                ctx.out.blockExecutable(task, block)
              },
            },
          }),
      }),
    ),
  }
}

export async function convertRuns(
  h: V2Harness,
  options: {
    readonly tasks: readonly TaskFacts[]
    readonly mounts?: readonly TaskMountFacts[]
    readonly resolution?: ConversionResolution
    readonly source?: () => Promise<VersionedSourceReader>
    readonly content?: ContentInventory
    readonly preflight?: (preflight: SourcePreflight) => SourcePreflight
  },
) {
  const calls: BlockExecutableCall[] = []
  let phase: BlockExecutableCall['phase'] = 'discover'
  const input = await h.input(
    [observedRuns(calls, () => phase), cancelingSettlement(options.tasks)],
    {
      fixtures: {
        taskMounts: options.mounts ?? options.tasks.map((task) => taskMounts(task.taskId)),
      },
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(options.source ? { source: await options.source() } : {}),
      ...(options.content ? { content: options.content } : {}),
    },
  )
  const source = input.source
  const converted: ConversionInput = options.preflight
    ? {
        ...input,
        preflight: options.preflight(input.preflight),
        // The reader is unchanged; this models independently captured source facts.
        source: { ...source, assertUnchanged: () => source.assertUnchanged(input.preflight) },
      }
    : input
  const sink = new V2MemorySink()
  try {
    const prepared = await prepareConversion(converted)
    try {
      phase = 'convert'
      const summary = await prepared.run(sink)
      return { plan: prepared.plan, summary, sink, calls }
    } finally {
      prepared.close()
    }
  } finally {
    await source.close()
  }
}
export type RunConversionResult = Awaited<ReturnType<typeof convertRuns>>

export const unitDispositions = (sink: V2MemorySink): readonly RowDisposition[] =>
  [...sink.units.values()].flatMap((unit) => unit.dispositions)
export const unitRecords = (sink: V2MemorySink): readonly MigrationRecord[] =>
  [...sink.units.values()].flatMap((unit) => unit.records)
export const decisionRecords = (sink: V2MemorySink, code: string) =>
  unitRecords(sink).filter(
    (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
      record.kind === 'decision' && record.code === code,
  )

/**
 * A source whose `node_runs` table the frozen codec rejects on one row: the strict read fails,
 * the engine restages the table through the raw channel and marks that row undecodable.
 */
export async function undecodableRunSource(
  h: V2Harness,
  runId: string,
): Promise<VersionedSourceReader> {
  const source = await h.sourceHarness.source()
  return {
    ...source,
    async readChunk(table, after, limit) {
      if (table === 'node_runs')
        throw new Error('logical database codec: fixture undecodable node run')
      return source.readChunk(table, after, limit)
    },
    async readRawChunk(table, after, limit) {
      const chunk = await source.readRawChunk(table, after, limit)
      if (table !== 'node_runs') return chunk
      return {
        ...chunk,
        rows: chunk.rows.map((row) =>
          row.cells.id && decodeLogicalValue(row.cells.id.value) === runId
            ? {
                ...row,
                cells: {
                  ...row.cells,
                  iteration: {
                    storageClass: 'text',
                    value: { type: 'text' as const, value: 'not-an-integer' },
                  },
                },
              }
            : row,
        ),
      }
    },
  }
}

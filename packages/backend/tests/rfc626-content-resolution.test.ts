// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.2.1-§3.2.2, §3.4 rows
// 1 and 2a-2d, §7 "共享内容" and "内容"): what the content rules do with data the automatic
// upgrade may not refuse for.
//
//   - Row 1: required content missing for an unfinished task ends that task. The rules'
//     `settles.tasksOf` is the very derivation the blocking uses, so one missing shared object
//     used by two unfinished tasks ends both, and the conversion that follows never reaches
//     `blockExecutable` (which would be an engine error).
//   - Row 2a: content lost at freeze is kept as missing (reference kept, receipt says so);
//     required content of an unfinished task goes the way of row 1.
//   - Row 2b①: bytes on disk that differ from the registered size or digest are kept as found;
//     reference, receipt and the row's own registration take the measured facts, and the
//     decision records both. ②: bytes that cannot be proven at all (unlisted file, read
//     failure) are kept as missing with their original reference, so a gate artifact still has
//     both content references the target probe requires.
//   - An engine contract error is never turned into a decision.
//   - Row 2c: required content without a provable task converts with a decision.
//   - Row 2d: catalog problems stay row-level blocks, which automatic resolution sets aside.
//   - Operator resolution keeps every block it had before.
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentBytes,
  contentDigest,
  contentFixture,
  contentLookups,
  FakeContentInventory,
  frozenValues,
  objectId,
  seedContentParents,
} from './helpers/rfc395V2/contentFixtures'
import {
  contentTaskJoins,
  decisions,
  prepareAndRun,
  setTaskStatus,
  settledTasks,
} from './helpers/rfc626CollabContentFixtures'
import { conversion as contentConversion } from '@/platform/content/migration'
import { contentSettlementTasks, contentTaskScope } from '@/platform/content/migration/receipts'
import {
  CONTENT_RESOURCE_TASKS,
  contentResourceKey,
} from '@/platform/content/migration/resourceClosure'
import type { ContentLocation } from '@/platform/content/contentRef'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  TASK_FACTS,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { LookupKey, LookupResolver } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ContentInventory,
  ContentStat,
} from '@/platform/persistence/migration/conversion/content'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

// The V2 content cases take about 3 s each on CI; two conversions per case.
setDefaultTimeout(60_000)

const final = { codec: 'review-body', value: 'runs/task/review/doc.md' }
const staged = { codec: 'review-body', value: 'runs/.staging/doc.md' }
const hostedObject = { codec: 'hosted-object-id', value: objectId }
const originallyAbsent: ContentStat = {
  state: 'absent',
  cause: 'originally-absent',
  evidence: 'absent in the frozen legacy input',
}
const lostAtFreeze: ContentStat = {
  state: 'absent',
  cause: 'missing-at-freeze',
  evidence: 'listed freeze file is now missing',
}
/** An inventory whose stat of one location throws, as the freeze inventory does. */
function failingAt(location: ContentLocation, error: Error): ContentInventory {
  const base = new FakeContentInventory()
  return {
    async stat(at) {
      if (canonicalSchemaJson(at) === canonicalSchemaJson(location)) throw error
      return base.stat(at)
    },
    read: (at) => base.read(at),
  }
}
const parse = (value: unknown) => JSON.parse(value as string) as Record<string, unknown>

// ---- the shared derivation, as pure functions ---------------------------------------------

function facts(taskId: string, status: string, execution: TaskFacts['execution']): TaskFacts {
  return {
    taskId,
    parentTaskId: null,
    rootTaskId: null,
    status,
    startedAt: 1,
    execution,
    subjectKind: 'workflow',
    sourceId: 'workflow',
    definitionAnchorId: 'workflow',
    engineKind: 'dag',
    spaceKind: 'internal',
    workflowVersion: 1,
  }
}
function resolver(entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  return (<V>(key: LookupKey<V>) => ({
    get: (id: string) => entries[key.id]?.[id] as V | undefined,
    sourceStatus: () => undefined,
    require(id: string) {
      const value = entries[key.id]?.[id]
      if (value === undefined) throw new Error(`fixture lookup ${key.id}/${id}`)
      return value as V
    },
    entries: () => Object.entries(entries[key.id] ?? {}) as [string, V][],
    version: { id: key.id, version: key.version, digest: 'fixture' },
  })) as LookupResolver
}
function row(table: string, values: DecodedSourceRow): SourceRow {
  const key = [canonicalValue(String(values.id ?? values.reference))]
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical: { key, values: [] },
    values,
  }
}

describe('RFC-626 §3.2.2: the content tasks a row may end', () => {
  const development = row('development_object_artifacts', { reference: 'blob:fixture' })
  const lookup = resolver({
    [TASK_FACTS.id]: {
      a: facts('a', 'running', 'executable'),
      b: facts('b', 'awaiting_human', 'executable'),
      done: facts('done', 'done', 'terminal-history'),
    },
    [CONTENT_RESOURCE_TASKS.id]: {
      [contentResourceKey(development)!]: [
        { taskId: 'a', evidence: ['x'] },
        { taskId: 'b', evidence: ['y'] },
        { taskId: 'unknown', evidence: ['z'] },
      ],
    },
  })
  test('a row with its own task names that task, whatever it uses', () => {
    expect(
      contentSettlementTasks(row('doc_versions', { id: 'doc', task_id: 'done' }), lookup),
    ).toEqual(['done'])
  })
  test('a shared resource without a task names every known task that uses it', () => {
    expect(contentSettlementTasks(development, lookup)).toEqual(['a', 'b'])
    const scope = contentTaskScope(development, lookup)
    expect(scope.provable && scope.uses.map((use) => use.taskId)).toEqual(['a', 'b', 'unknown'])
  })
  test('a row whose task the facts do not know names none (row 2c), unrelated rows neither', () => {
    const ghost = row('doc_versions', { id: 'ghost-doc', task_id: 'ghost' })
    expect(contentTaskScope(ghost, lookup)).toEqual({ provable: false, taskId: 'ghost' })
    expect(contentSettlementTasks(ghost, lookup)).toEqual([])
    expect(contentSettlementTasks(row('employee_reaction_artifacts', { id: 'e' }), lookup)).toEqual(
      [],
    )
  })
  test('every content rule declares exactly that derivation', () => {
    expect(contentConversion.rules.length).toBeGreaterThan(0)
    for (const rule of contentConversion.rules)
      expect(rule.settles?.tasksOf).toBe(contentSettlementTasks)
  })
  test('source text: tasksOf and the blocking share one function (design §7 共享内容)', () => {
    const migration = resolve(import.meta.dir, '../src/platform/content/migration')
    const receipts = readFileSync(resolve(migration, 'receipts.ts'), 'utf8')
    const index = readFileSync(resolve(migration, 'index.ts'), 'utf8')
    expect(index).toContain('settles: { tasksOf: contentSettlementTasks }')
    const tasksOf = receipts.slice(
      receipts.indexOf('export function contentSettlementTasks'),
      receipts.indexOf('export function contentUncertainty'),
    )
    const blocking = receipts.slice(receipts.indexOf('export function contentUncertainty'))
    expect(tasksOf).toContain('contentTaskScope(row, lookup)')
    expect(blocking).toContain('contentTaskScope(row,')
    // The task set is derived in one place only.
    expect(blocking).not.toContain('taskIdentity(')
    expect(blocking).not.toContain('CONTENT_RESOURCE_TASKS')
    expect(receipts.split('taskIdentity(').length - 1).toBe(2) // definition + one call
    expect(receipts.split('lookup(CONTENT_RESOURCE_TASKS)').length - 1).toBe(1)
  })
})

describeV2Providers('RFC-626 content rules under automatic resolution', (h) => {
  test('shared content: one missing object used by two unfinished tasks ends both', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('employee_cases', [frozenValues('employee_cases', { id: 'case' })])
    for (const [taskId, status] of [
      ['consumer-a', 'running'],
      ['consumer-b', 'awaiting_human'],
    ] as const)
      await h.write('tasks', [
        frozenValues('tasks', {
          id: taskId,
          workflow_id: 'workflow',
          inputs: '{}',
          workflow_snapshot: '{"nodes":[],"edges":[]}',
          status,
          digital_employee_round_id: `round-${taskId}`,
        }),
      ])
    for (const taskId of ['consumer-a', 'consumer-b'])
      await h.write('employee_reaction_rounds', [
        frozenValues('employee_reaction_rounds', {
          id: `round-${taskId}`,
          case_id: 'case',
          // One case holds at most one active round; the closure does not look at the state.
          state: 'completed',
          execution_ref: taskId,
          plan_json: JSON.stringify({
            inputEnvelopeJson: JSON.stringify({
              contextsJson: JSON.stringify([
                {
                  stateJson: JSON.stringify({ materialArtifactRefs: ['blob:fixture'] }),
                  artifactRefs: [],
                },
              ]),
            }),
          }),
        }),
      ])
    await h.write('development_object_artifacts', [contentFixture('development_object_artifacts')])
    const content = new FakeContentInventory().set(hostedObject, originallyAbsent)

    const operator = await prepareAndRun(h, [contentConversion, settledTasks, contentTaskJoins()], {
      content,
    })
    expect(
      operator.summary.blocks
        .filter((block) => block.sourceTable === 'development_object_artifacts')
        .map((block) => [block.code, block.taskId])
        .sort(),
    ).toEqual([
      ['v2-content-required-missing', 'consumer-a'],
      ['v2-content-required-missing', 'consumer-b'],
    ])

    const automatic = await prepareAndRun(
      h,
      [contentConversion, settledTasks, contentTaskJoins()],
      { content, resolution: 'automatic' },
    )
    expect(automatic.plan.settlements).toEqual([
      {
        taskId: 'consumer-a',
        cause: 'unprovable-records',
        originalStatus: 'running',
        blockCodes: ['v2-content-required-missing'],
        parentTaskId: null,
      },
      {
        taskId: 'consumer-b',
        cause: 'unprovable-records',
        originalStatus: 'awaiting_human',
        blockCodes: ['v2-content-required-missing'],
        parentTaskId: null,
      },
    ])
    // Reaching blockExecutable during the conversion itself would have failed the run.
    expect(automatic.summary.blocks).toEqual([])
    const [artifact] = automatic.sink.rows('development_object_artifacts')
    expect(parse(artifact!.content_ref_json).location).toEqual(hostedObject)
    expect(
      automatic.dispositions
        .filter(
          (d) => d.sourceTable === 'development_object_artifacts' && d.kind === 'history-only',
        )
        .map((d) => [d.history?.taskId, d.history?.execution])
        .sort(),
    ).toEqual([
      ['consumer-a', 'retryable-history'],
      ['consumer-b', 'retryable-history'],
    ])
  })

  test('row 1: missing required content ends its unfinished task; operator still blocks', async () => {
    await h.install()
    await seedContentParents(h)
    await setTaskStatus(h, 'task', 'running')
    const content = new FakeContentInventory().set(final, originallyAbsent)
    const contributions = [contentConversion, settledTasks, contentTaskJoins()]

    const operator = await prepareAndRun(h, contributions, { content })
    expect(operator.summary.blocks).toContainEqual(
      expect.objectContaining({
        code: 'v2-content-required-missing',
        scope: 'row',
        sourceTable: 'doc_versions',
        taskId: 'task',
      }),
    )
    expect(operator.sink.rows('doc_versions')).toEqual([])

    const automatic = await prepareAndRun(h, contributions, { content, resolution: 'automatic' })
    expect(automatic.plan.settlements).toEqual([
      {
        taskId: 'task',
        cause: 'unprovable-records',
        originalStatus: 'running',
        blockCodes: ['v2-content-required-missing'],
        parentTaskId: null,
      },
    ])
    expect(automatic.summary.blocks).toEqual([])
    expect(parse(automatic.sink.rows('doc_versions')[0]!.content_ref_json).location).toEqual(final)
    expect(automatic.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: 'doc_versions',
        kind: 'history-only',
        history: {
          taskId: 'task',
          runId: null,
          execution: 'retryable-history',
          missingFields: ['body_path'],
        },
      }),
    )
    expect(automatic.artifacts).toContainEqual(
      expect.objectContaining({
        sourceTable: 'doc_versions',
        missing: { state: 'originally-absent', evidence: originallyAbsent.evidence },
      }),
    )
    expect(automatic.summary.resolutions?.missingContent.total).toBeGreaterThanOrEqual(1)
  })

  test('row 2a: optional content lost at freeze is kept as missing; operator still blocks', async () => {
    await h.install()
    await seedContentParents(h)
    // Finalized: the final copy is required, the staged copy is not.
    await h.write('collaboration_gate_artifacts', [contentFixture('collaboration_gate_artifacts')])
    const content = new FakeContentInventory().set(staged, lostAtFreeze)

    const operator = await prepareAndRun(h, [contentConversion, contentLookups()], { content })
    expect(operator.summary.blocks).toContainEqual(
      expect.objectContaining({
        code: 'v2-content-lost-at-freeze',
        scope: 'row',
        sourceTable: 'collaboration_gate_artifacts',
      }),
    )
    expect(operator.sink.rows('collaboration_gate_artifacts')).toEqual([])

    const automatic = await prepareAndRun(h, [contentConversion, contentLookups()], {
      content,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    const [gate] = automatic.sink.rows('collaboration_gate_artifacts')
    expect(parse(gate!.staged_content_ref_json).location).toEqual(staged)
    expect(parse(gate!.content_ref_json).location).toEqual(final)
    expect(automatic.artifacts).toContainEqual(
      expect.objectContaining({
        sourceTable: 'collaboration_gate_artifacts',
        sourceColumn: 'staged_path',
        bytes: null,
        missing: { state: 'missing-at-freeze', evidence: lostAtFreeze.evidence },
      }),
    )
    const kept = decisions(automatic.records, 'v2-content-lost-at-freeze-kept')
    expect(kept).toHaveLength(1)
    expect(kept[0]!.payload).toMatchObject({
      automatic: 'kept',
      sourceTable: 'collaboration_gate_artifacts',
      column: 'staged_path',
      reference: staged.value,
      required: false,
    })
    expect(
      automatic.dispositions.some(
        (d) => d.sourceTable === 'collaboration_gate_artifacts' && d.kind === 'history-only',
      ),
    ).toBe(false)
  })

  test('row 2a: required content lost at freeze ends its unfinished task like row 1', async () => {
    await h.install()
    await seedContentParents(h)
    await setTaskStatus(h, 'task', 'awaiting_review')
    const automatic = await prepareAndRun(
      h,
      [contentConversion, settledTasks, contentTaskJoins()],
      { content: new FakeContentInventory().set(final, lostAtFreeze), resolution: 'automatic' },
    )
    expect(automatic.plan.settlements).toEqual([
      {
        taskId: 'task',
        cause: 'unprovable-records',
        originalStatus: 'awaiting_review',
        blockCodes: ['v2-content-lost-at-freeze'],
        parentTaskId: null,
      },
    ])
    expect(automatic.summary.blocks).toEqual([])
    expect(parse(automatic.sink.rows('doc_versions')[0]!.content_ref_json).location).toEqual(final)
    expect(automatic.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: 'doc_versions',
        kind: 'history-only',
        decision: expect.objectContaining({ code: 'v2-content-lost-at-freeze' }),
        history: expect.objectContaining({ taskId: 'task', execution: 'retryable-history' }),
      }),
    )
    expect(
      decisions(automatic.records, 'v2-content-lost-at-freeze-kept')[0]!.payload,
    ).toMatchObject({ sourceTable: 'doc_versions', column: 'body_path', required: true })
  })

  test('row 2b①: bytes that differ from the registration are kept as found on disk', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('collaboration_gate_artifacts', [contentFixture('collaboration_gate_artifacts')])
    const changed = new Uint8Array([1, 2, 3])
    const measured = { sha256: bytesDigest(changed).slice(7), size: changed.byteLength }
    const content = new FakeContentInventory().set(final, changed)

    const operator = await prepareAndRun(h, [contentConversion, contentLookups()], { content })
    expect(operator.summary.blocks).toContainEqual(
      expect.objectContaining({
        code: 'v2-content-bytes-unprovable',
        sourceTable: 'collaboration_gate_artifacts',
        detail: { column: 'final_path', message: 'v2-content-inventory-mismatch' },
      }),
    )

    const automatic = await prepareAndRun(h, [contentConversion, contentLookups()], {
      content,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    const [gate] = automatic.sink.rows('collaboration_gate_artifacts')
    expect(parse(gate!.content_ref_json)).toMatchObject({ location: final, ...measured })
    // The row's own registration agrees with the reference again.
    expect(gate).toMatchObject({ sha256: measured.sha256, byte_size: measured.size })
    // The staged copy was as registered and keeps its reference.
    expect(parse(gate!.staged_content_ref_json)).toMatchObject({
      location: staged,
      sha256: contentDigest,
      size: contentBytes.byteLength,
    })
    expect(automatic.artifacts).toContainEqual(
      expect.objectContaining({
        sourceTable: 'collaboration_gate_artifacts',
        sourceColumn: 'final_path',
        bytes: measured,
        missing: null,
      }),
    )
    const kept = decisions(automatic.records, 'v2-content-kept-differs-from-registered')
    expect(kept).toHaveLength(1)
    expect(kept[0]!.payload).toMatchObject({
      automatic: 'kept',
      sourceTable: 'collaboration_gate_artifacts',
      column: 'final_path',
      reference: final.value,
      source: 'reference',
      registered: { sha256: contentDigest, size: contentBytes.byteLength },
      measured,
    })
    expect(
      automatic.summary.resolutions?.kept.byCode['v2-content-kept-differs-from-registered'],
    ).toBe(1)
  })

  test('row 2b②: bytes that cannot be proven are kept as missing with their reference', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('collaboration_gate_artifacts', [contentFixture('collaboration_gate_artifacts')])
    const content = failingAt(final, new Error('content-unlisted-present'))

    const operator = await prepareAndRun(h, [contentConversion, contentLookups()], { content })
    expect(
      operator.summary.blocks
        .filter((block) => block.code === 'v2-content-bytes-unprovable')
        .map((block) => block.sourceTable)
        .sort(),
    ).toEqual(['collaboration_gate_artifacts', 'doc_versions'])
    expect(operator.sink.rows('collaboration_gate_artifacts')).toEqual([])

    const automatic = await prepareAndRun(h, [contentConversion, contentLookups()], {
      content,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    // Both content references stay set: the gate probe requires them for a finalized artifact.
    const [gate] = automatic.sink.rows('collaboration_gate_artifacts')
    expect(gate!.content_ref_json).not.toBeNull()
    expect(gate!.staged_content_ref_json).not.toBeNull()
    expect(parse(gate!.content_ref_json).location).toEqual(final)
    expect(parse(gate!.staged_content_ref_json).location).toEqual(staged)
    expect(parse(automatic.sink.rows('doc_versions')[0]!.content_ref_json).location).toEqual(final)
    const receipt = automatic.artifacts.find(
      (entry) =>
        entry.sourceTable === 'collaboration_gate_artifacts' && entry.sourceColumn === 'final_path',
    )!
    expect(receipt.bytes).toBeNull()
    expect(receipt.missing?.state).toBe('missing-at-freeze')
    expect(receipt.missing?.evidence).toContain('content-unlisted-present')
    expect(automatic.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: 'collaboration_gate_artifacts',
        kind: 'history-only',
        decision: expect.objectContaining({ code: 'v2-content-bytes-unprovable' }),
        history: expect.objectContaining({ taskId: 'task', execution: 'terminal-history' }),
      }),
    )
    const kept = decisions(automatic.records, 'v2-content-bytes-unprovable-kept')
    expect(
      kept.map((record) => (record.payload as { sourceTable: string }).sourceTable).sort(),
    ).toEqual(['collaboration_gate_artifacts', 'doc_versions'])
  })

  test('row 2b②: required bytes that cannot be proven end their unfinished task', async () => {
    await h.install()
    await seedContentParents(h)
    await setTaskStatus(h, 'task', 'pending')
    const automatic = await prepareAndRun(
      h,
      [contentConversion, settledTasks, contentTaskJoins()],
      {
        content: failingAt(final, new Error('EACCES: permission denied')),
        resolution: 'automatic',
      },
    )
    expect(automatic.plan.settlements).toEqual([
      {
        taskId: 'task',
        cause: 'unprovable-records',
        originalStatus: 'pending',
        blockCodes: ['v2-content-bytes-unprovable'],
        parentTaskId: null,
      },
    ])
    expect(automatic.summary.blocks).toEqual([])
    expect(parse(automatic.sink.rows('doc_versions')[0]!.content_ref_json).location).toEqual(final)
    expect(
      automatic.artifacts.find((entry) => entry.sourceTable === 'doc_versions')!.missing?.evidence,
    ).toContain('EACCES')
  })

  test('an engine contract error from the inventory ends the conversion instead of a decision', async () => {
    await h.install()
    await seedContentParents(h)
    const content = failingAt(final, new ConversionContractError('v2-fixture-contract', 'fault'))
    const input = await h.input([contentConversion, contentLookups()], {
      content,
      resolution: 'automatic',
    })
    try {
      await expect(runConversion(input, new V2MemorySink())).rejects.toThrow('v2-fixture-contract')
    } finally {
      await input.source.close()
    }
    // Operator resolution keeps reporting it as the row's block, as before.
    const operator = await prepareAndRun(h, [contentConversion, contentLookups()], { content })
    expect(operator.summary.blocks).toContainEqual(
      expect.objectContaining({
        code: 'v2-content-bytes-unprovable',
        sourceTable: 'doc_versions',
        detail: { column: 'body_path', message: 'v2-fixture-contract: fault' },
      }),
    )
  })

  test('row 2c: required content whose task cannot be proven converts with a decision', async () => {
    await h.install()
    await seedContentParents(h)
    const content = new FakeContentInventory().set(final, originallyAbsent)

    const operator = await prepareAndRun(h, [contentConversion, contentLookups([])], { content })
    expect(operator.summary.blocks).toContainEqual(
      expect.objectContaining({ code: 'v2-content-task-unprovable', taskId: 'task' }),
    )

    const automatic = await prepareAndRun(h, [contentConversion, contentLookups([])], {
      content,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.plan.settlements ?? []).toEqual([])
    expect(parse(automatic.sink.rows('doc_versions')[0]!.content_ref_json).location).toEqual(final)
    const kept = decisions(automatic.records, 'v2-content-task-unprovable-kept')
    expect(kept).toHaveLength(1)
    expect(kept[0]!.payload).toMatchObject({
      automatic: 'kept',
      sourceTable: 'doc_versions',
      taskId: 'task',
      code: 'v2-content-required-missing',
      missingFields: ['body_path'],
    })
    expect(automatic.dispositions.some((d) => d.kind === 'history-only')).toBe(false)
  })

  test('row 2d: a catalog conflict is a row-level block that automatic resolution sets aside', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('hosted_task_artifacts', [
      contentFixture('hosted_task_artifacts'),
      contentFixture('hosted_task_artifacts', {
        reference: 'runs/task/ports/run/other',
        digest: bytesDigest(new Uint8Array([9])).slice(7),
      }),
    ])
    const content = new FakeContentInventory()

    const operator = await prepareAndRun(h, [contentConversion, contentLookups()], { content })
    const conflicts = operator.summary.blocks.filter(
      (block) => block.code === 'v2-content-object-conflict',
    )
    expect(conflicts).toHaveLength(2)
    for (const block of conflicts)
      expect(block).toMatchObject({ scope: 'row', sourceTable: 'hosted_task_artifacts' })

    const automatic = await prepareAndRun(h, [contentConversion, contentLookups()], {
      content,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.sink.rows('hosted_task_artifacts')).toEqual([])
    expect(
      automatic.dispositions.filter(
        (d) =>
          d.sourceTable === 'hosted_task_artifacts' &&
          d.class === 'archived' &&
          d.decision?.code === 'v2-content-object-conflict',
      ),
    ).toHaveLength(2)
    expect(
      decisions(automatic.records, 'v2-row-set-aside').filter(
        (record) => (record.payload as { code: string }).code === 'v2-content-object-conflict',
      ),
    ).toHaveLength(2)
  })
})

// RFC-626 design §3.3 "悬空行" and §3.4 rows 11 / 11b. With automatic resolution a row whose
// reference points at a row missing from the source is kept and only the reference changes:
// `users.created_by` and `development_missions.reopened_from_mission_id` are cleared,
// `task_collaborators.added_by` (not nullable) is re-pointed at the system user `__system__`,
// each with a `v2-dangling-reference-kept` decision carrying the original value. The keep
// policies come from one constant, declared as the alignment contribution's `references` (which
// the target finalize applies when the referenced row is set aside during the conversion) and
// applied by the rules themselves — so both paths give the referring row the same outcome.
// Operator resolution still blocks.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  coreBFixture,
  writeFrozenFixture,
  writeTaskFixture,
} from './rfc395-v2-generic-fixtures.test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { conversion as alignment } from '@/platform/persistence/migration/conversion/alignment'
import { DANGLING_REFERENCE_KEPT } from '@/platform/persistence/migration/conversion/alignment/common'
import { alignmentReferencePolicies } from '@/platform/persistence/migration/conversion/alignment/referencePolicies'
import { missionIds, userIds } from '@/platform/persistence/migration/conversion/generic/references'
import { requiredSeedKeysByTable } from '@/platform/persistence/migration/conversion/requiredSeeds'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'

const alignmentRoot = join(
  import.meta.dir,
  '../src/platform/persistence/migration/conversion/alignment',
)

test('the conversion applies the same keep-policy constant the contribution declares', () => {
  expect(alignment.references).toBe(alignmentReferencePolicies)
  const index = readFileSync(join(alignmentRoot, 'index.ts'), 'utf8')
  const common = readFileSync(join(alignmentRoot, 'common.ts'), 'utf8')
  expect(index).toContain('references: alignmentReferencePolicies')
  expect(common).toContain('alignmentReferencePolicies.find(')
  // No second copy of a policy anywhere in the rules.
  for (const name of ['common.ts', 'users.ts', 'taskCollaborators.ts', 'developmentMissions.ts'])
    for (const policy of alignmentReferencePolicies)
      expect(readFileSync(join(alignmentRoot, name), 'utf8')).not.toContain(policy.foreignKey)
})

test('each keep policy names a target foreign key and re-points only at required seed rows', () => {
  const seeds = requiredSeedKeysByTable(persistenceSchema)
  for (const policy of alignmentReferencePolicies) {
    const table = persistenceSchema.tables.find((entry) => entry.id === policy.table)!
    const foreignKey = table.foreignKeys.find((entry) => entry.name === policy.foreignKey)!
    expect(foreignKey).toBeDefined()
    // A foreign key the target already detaches needs no declaration.
    expect(foreignKey.onDelete).not.toBe('set null')
    const action = policy.action
    if (action.kind === 'substitute') {
      expect(
        Object.keys(action.values).every((column) => foreignKey.columns.includes(column)),
      ).toBe(true)
      const key = encodeMigrationKey(
        foreignKey.foreignTable,
        foreignKey.foreignColumns.map((_, index) =>
          canonicalValue(action.values[foreignKey.columns[index]!]!),
        ),
      )
      expect(seeds.get(foreignKey.foreignTable) ?? []).toContain(key)
    }
  }
  expect(alignmentReferencePolicies.map((policy) => [policy.table, policy.action.kind])).toEqual([
    ['development_missions', 'detach'],
    ['task_collaborators', 'substitute'],
  ])
  // users.created_by is detached by the schema itself, without a declaration.
  const users = persistenceSchema.tables.find((entry) => entry.id === 'users')!
  expect(users.foreignKeys.find((entry) => entry.columns.includes('created_by'))?.onDelete).toBe(
    'set null',
  )
})

const kept = (sink: V2MemorySink) =>
  [...sink.units.values()]
    .flatMap((unit) => unit.records)
    .filter(
      (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
        record.kind === 'decision' && record.code === DANGLING_REFERENCE_KEPT,
    )

describeV2Providers('RFC-626 dangling references kept', (h) => {
  test('automatic clears or re-points the reference and keeps the row; operator blocks', async () => {
    await h.install()
    await writeTaskFixture(h)
    // The referenced rows exist physically; the lookups below leave them out, which is how the
    // converter sees a reference to a row absent from the source.
    await writeFrozenFixture(h, 'users', { id: 'creator', username: 'creator' })
    await writeFrozenFixture(h, 'users', {
      id: 'created-user',
      username: 'created-user',
      created_by: 'creator',
    })
    await writeFrozenFixture(h, 'task_collaborators', {
      task_id: 'fixture-task',
      user_id: 'created-user',
      added_by: 'creator',
    })
    // Finished missions: an unfinished one is set aside before its reference matters.
    await writeFrozenFixture(h, 'development_missions', { id: 'prior-mission', terminal_at: 100 })
    await writeFrozenFixture(h, 'development_missions', {
      id: 'reopened-mission',
      reopened_from_mission_id: 'prior-mission',
      terminal_at: 200,
    })
    const input = await h.input([
      coreBFixture(
        ['users', 'task_collaborators', 'development_missions'],
        [
          fixtureLookup(userIds.key, [
            ['__system__', true],
            ['created-user', true],
          ]),
          fixtureLookup(missionIds.key, [['reopened-mission', true]]),
        ],
      ),
    ])
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(sink.rows('users').find((row) => row.id === 'created-user')!.created_by).toBeNull()
      expect(sink.rows('task_collaborators')).toEqual([
        expect.objectContaining({
          task_id: 'fixture-task',
          user_id: 'created-user',
          added_by: '__system__',
        }),
      ])
      expect(
        sink.rows('development_missions').find((row) => row.id === 'reopened-mission')!
          .reopened_from_mission_id,
      ).toBeNull()
      const decisions = kept(sink)
      for (const [table, column, action, after, original] of [
        ['users', 'created_by', 'detached', { type: 'null' }, 'creator'],
        [
          'task_collaborators',
          'added_by',
          'substituted',
          { type: 'text', value: '__system__' },
          'creator',
        ],
        [
          'development_missions',
          'reopened_from_mission_id',
          'detached',
          { type: 'null' },
          'prior-mission',
        ],
      ] as const)
        expect(decisions).toContainEqual(
          expect.objectContaining({
            payload: expect.objectContaining({
              automatic: 'kept',
              sourceTable: table,
              column,
              action,
              previous: { [column]: { type: 'text', value: original } },
              values: { [column]: after },
            }),
          }),
        )
      expect(decisions).toHaveLength(3)
      // Each kept row also carries the change as a disposition, like the memory pointers do.
      const changed = [...sink.units.values()]
        .flatMap((unit) => unit.dispositions)
        .filter((entry) => entry.decision?.code === DANGLING_REFERENCE_KEPT)
      expect(changed).toHaveLength(3)
      expect(changed.every((entry) => entry.kind === 'conflict-resolved')).toBe(true)

      // Operator resolution: the three rows block exactly as before RFC-626.
      const manual = await runConversion(input, new V2MemorySink())
      expect(manual.status).toBe('blocked')
      expect(
        manual.blocks
          .filter((block) => block.code === 'v2-dangling-reference')
          .map((block) => block.sourceTable)
          .sort(),
      ).toEqual(['development_missions', 'task_collaborators', 'users'])
    } finally {
      await input.source.close()
    }
  }, 180_000)
})

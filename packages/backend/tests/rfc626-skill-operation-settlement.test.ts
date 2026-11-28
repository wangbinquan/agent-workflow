// RFC-626 design §3.4 row 3c and §3.3 "the upgraded service must start". Locks that
// skill_operations / skill_operation_locks belong to the skill rule's groups (no longer the
// generic copy) and that, with automatic resolution, a skill disposed of because an operation
// was interrupted ends that operation: the operation converts with active=0 and its lock is set
// aside, for each of the four recovery directions of skillOpRecovery.ts. The converted rows are
// then put through the new version's skill-operation recovery boot step
// (skillCatalogBootAdapter.recoverOperations), which must accept them — while the same rows
// carried over unchanged are refused, which is why the settlement exists. With operator
// resolution the blocks are unchanged and both tables are copied as the generic copy copied them.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableColumns, type Table } from 'drizzle-orm'
import {
  createSkillBootConversion,
  skillOperationDirection,
  SKILL_OPERATION_KEPT_INACTIVE,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import { createSkillCatalogBootAdapter } from '@/modules/resource-catalog/infrastructure/skillCatalogBootAdapter'
import { skillBootIdentityFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { genericCopyTables } from '@/platform/persistence/migration/conversion/generic/tables'
import { buildLookups } from '@/platform/persistence/migration/conversion/lookups'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { convertFrozenSkillContent } from '@/platform/content/migration/skillContent'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { conversionContributions } from '@/bootstrap/conversionRules'
import { createTestDb } from './helpers/testDatabase'
import { runRuleUnit } from './helpers/rfc626CatalogRuleUnit'
import {
  HOME,
  SKILL,
  convertSkills,
  frozenTree,
  lockSource,
  operationSource,
  skillFact,
  skillSource,
  versionSource,
} from './helpers/rfc626SkillFixtures'

/** What the generic copy produced for these rows before RFC-626. */
async function genericCopy(
  rows: readonly SourceRow[],
  table: string,
): Promise<readonly TargetRow[]> {
  return (await runRuleUnit({ rule: preservedRule(table), lookups: [], rows })).rows(table)
}

function byOperation(rows: readonly TargetRow[]): TargetRow[] {
  return [...rows].sort((a, b) => String(a.op_id).localeCompare(String(b.op_id)))
}

function columnsOf(table: Table, row: TargetRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([, column]) => Object.hasOwn(row, column.name))
      .map(([key, column]) => [key, row[column.name]]),
  )
}

/** Installs converted rows in a fresh target database and runs the boot step on them. */
async function bootRecovery(rows: {
  readonly skills?: readonly TargetRow[]
  readonly skill_versions?: readonly TargetRow[]
  readonly skill_operations?: readonly TargetRow[]
  readonly skill_operation_locks?: readonly TargetRow[]
}) {
  const fixture = await createTestDb({ provider: 'sqlite' })
  const appHome = mkdtempSync(join(tmpdir(), 'rfc626-skill-boot-'))
  try {
    const { skills, skillVersions, skillOperations, skillOperationLocks } = tablesOf(fixture.db)
    for (const row of rows.skills ?? [])
      await fixture.db.insert(skills).values(columnsOf(skills, row) as never)
    for (const row of rows.skill_versions ?? [])
      await fixture.db.insert(skillVersions).values(columnsOf(skillVersions, row) as never)
    for (const row of rows.skill_operations ?? [])
      await fixture.db.insert(skillOperations).values(columnsOf(skillOperations, row) as never)
    for (const row of rows.skill_operation_locks ?? [])
      await fixture.db
        .insert(skillOperationLocks)
        .values(columnsOf(skillOperationLocks, row) as never)
    return await createSkillCatalogBootAdapter({ db: fixture.db, appHome }).recoverOperations()
  } finally {
    await fixture.close()
    rmSync(appHome, { recursive: true, force: true })
  }
}

describe('RFC-626 3c: an interrupted skill operation is settled with its skill', () => {
  const cases = [
    {
      direction: 'rollback',
      kind: 'reserve',
      phase: 'intent',
      reservation: 'reserving',
      withVersion: false,
      outcome: 'set-aside',
    },
    {
      direction: 'rollforward',
      kind: 'version-write',
      phase: 'db-committed',
      reservation: 'ready',
      withVersion: true,
      outcome: 'quarantine',
    },
    {
      direction: 'noop',
      kind: 'delete',
      phase: 'done',
      reservation: 'ready',
      withVersion: true,
      outcome: 'quarantine',
    },
    {
      direction: 'quarantine',
      kind: 'reserve',
      phase: 'fs-versioned',
      reservation: 'ready',
      withVersion: true,
      outcome: 'quarantine',
    },
  ] as const
  function fixture(item: (typeof cases)[number]) {
    const skill = skillSource({
      reservation_state: item.reservation,
      content_version: item.withVersion ? 1 : 0,
    })
    const operation = operationSource({ kind: item.kind, phase: item.phase, active: 1 })
    const lock = lockSource()
    const rows = [skill, ...(item.withVersion ? [versionSource()] : []), operation, lock]
    const fact = skillFact(skill, {
      reason: 'v2-boot-skill-operation-unsettled',
      roots: [`${HOME}/skills/${SKILL}`],
    })
    return { skill, operation, lock, rows, fact }
  }

  for (const item of cases)
    test(`${item.direction}: operation inactive, lock set aside, the boot step accepts it`, async () => {
      const { skill, operation, lock, rows, fact } = fixture(item)
      expect(skillOperationDirection(operation.values)).toBe(item.direction)
      const result = await convertSkills({ rows, facts: [fact], resolution: 'automatic' })
      expect(result.output.blocks).toEqual([])
      const copied = await genericCopy([operation], 'skill_operations')
      expect(result.rows('skill_operations')).toEqual(copied.map((row) => ({ ...row, active: 0 })))
      expect(result.rows('skill_operation_locks')).toEqual([])
      const archived = (row: SourceRow) =>
        result.output.dispositions.find(
          (disposition) =>
            disposition.sourceKey === row.encodedKey && disposition.class === 'archived',
        )
      expect(archived(lock)?.decision?.code).toBe('v2-boot-skill-operation-unsettled')
      expect(result.decisions(SKILL_OPERATION_KEPT_INACTIVE)).toEqual([
        expect.objectContaining({
          automatic: 'kept',
          sourceTable: 'skill_operations',
          skillId: SKILL,
          opId: 'op-1',
          kind: item.kind,
          phase: item.phase,
          direction: item.direction,
        }),
      ])
      if (item.outcome === 'set-aside') {
        // A creation that never reached its database commit was never published (3b).
        expect(result.rows('skills')).toEqual([])
        expect(archived(skill)?.decision).toMatchObject({
          code: 'v2-boot-skill-operation-unsettled',
          detail: {
            skillId: SKILL,
            roots: [`${HOME}/skills/${SKILL}`],
            operations: [
              { opId: 'op-1', kind: item.kind, phase: item.phase, direction: item.direction },
            ],
          },
        })
      } else {
        expect(result.rows('skills')).toEqual([
          expect.objectContaining({ id: SKILL, version_state: 'quarantined' }),
        ])
        expect(result.rows('skill_versions')).toHaveLength(1)
      }
      // The new version's skill-operation recovery runs on exactly these rows and starts.
      expect(
        await bootRecovery({
          skills: result.rows('skills'),
          skill_versions: result.rows('skill_versions'),
          skill_operations: result.rows('skill_operations'),
          skill_operation_locks: result.rows('skill_operation_locks'),
        }),
      ).toMatchObject({ total: 0, rolledBack: 0, rolledForward: 0, orphanLocksCleared: 0 })
    })

  for (const item of cases.filter(
    (entry) => entry.direction === 'rollback' || entry.direction === 'rollforward',
  ))
    test(`${item.direction}: carried over unchanged, the same operation stops the boot step`, async () => {
      const { operation, lock, rows, fact } = fixture(item)
      const result = await convertSkills({ rows, facts: [fact], resolution: 'automatic' })
      await expect(
        bootRecovery({
          skills: result.rows('skills'),
          skill_versions: result.rows('skill_versions'),
          skill_operations: await genericCopy([operation], 'skill_operations'),
          skill_operation_locks: await genericCopy([lock], 'skill_operation_locks'),
        }),
      ).rejects.toThrow()
    })

  for (const item of cases)
    test(`${item.direction}: operator resolution blocks the skill and copies operation and lock`, async () => {
      const { operation, lock, rows, fact } = fixture(item)
      const result = await convertSkills({ rows, facts: [fact] })
      expect(
        result.output.blocks.map((block) => [block.code, block.sourceTable, block.detail]),
      ).toEqual(
        expect.arrayContaining([
          ['v2-boot-skill-operation-unsettled', 'skills', { skillId: SKILL }],
        ]),
      )
      expect(result.output.blocks).toHaveLength(item.withVersion ? 2 : 1)
      expect(result.rows('skill_operations')).toEqual(
        await genericCopy([operation], 'skill_operations'),
      )
      expect(result.rows('skill_operation_locks')).toEqual(
        await genericCopy([lock], 'skill_operation_locks'),
      )
      expect(result.decisions(SKILL_OPERATION_KEPT_INACTIVE)).toEqual([])
    })
})

describe('RFC-626 3c: operation rows without a skill row', () => {
  // The audit trail of a deleted skill, and a deletion committed in the database whose tidy-up
  // was interrupted. Neither has a skill row or versions.
  const history = operationSource({
    op_id: 'op-history',
    skill_id: 'deleted-skill',
    kind: 'delete',
    phase: 'done',
    active: 0,
  })
  const pending = operationSource({
    op_id: 'op-pending',
    skill_id: 'deleting-skill',
    kind: 'delete',
    phase: 'db-committed',
    active: 1,
  })
  const pendingLock = lockSource({ locked_skill_id: 'deleting-skill', op_id: 'op-pending' })
  const rows = [history, pending, pendingLock]
  const groupKeys = ['deleted-skill', 'deleting-skill']

  test('they get groups of their own instead of orphan blocks', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'rfc626-skill-groups-'))
    const staged = createStagingStore(scratch)
    try {
      for (const row of [history, lockSource({ locked_skill_id: 'lock-only', op_id: 'op-x' })])
        staged.put(row)
      const lookup = await buildLookups(
        createSkillBootConversion(convertFrozenSkillContent).lookups,
        staged,
      )
      expect([...lookup(skillBootIdentityFacts).entries()].map(([key]) => key).sort()).toEqual([
        'deleted-skill',
        'lock-only',
      ])
    } finally {
      staged.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('operator resolution copies them exactly as the generic copy did, without blocks', async () => {
    const result = await convertSkills({ rows, facts: [], groupKeys })
    expect(result.output.blocks).toEqual([])
    expect(byOperation(result.rows('skill_operations'))).toEqual(
      byOperation(await genericCopy([history, pending], 'skill_operations')),
    )
    expect(result.rows('skill_operation_locks')).toEqual(
      await genericCopy([pendingLock], 'skill_operation_locks'),
    )
  })

  test('automatic resolution ends the pending one and the boot step accepts the result', async () => {
    const result = await convertSkills({ rows, facts: [], groupKeys, resolution: 'automatic' })
    expect(result.output.blocks).toEqual([])
    const copied = await genericCopy([history, pending], 'skill_operations')
    expect(byOperation(result.rows('skill_operations'))).toEqual(
      byOperation(copied.map((row) => (row.op_id === 'op-pending' ? { ...row, active: 0 } : row))),
    )
    expect(result.rows('skill_operation_locks')).toEqual([])
    expect(
      result.output.dispositions.find(
        (disposition) => disposition.sourceKey === pendingLock.encodedKey,
      ),
    ).toMatchObject({ class: 'archived', decision: { code: 'v2-boot-skill-operation-unsettled' } })
    expect(result.decisions(SKILL_OPERATION_KEPT_INACTIVE)).toEqual([
      expect.objectContaining({ opId: 'op-pending', direction: 'rollforward' }),
    ])
    expect(
      await bootRecovery({
        skill_operations: result.rows('skill_operations'),
        skill_operation_locks: result.rows('skill_operation_locks'),
      }),
    ).toMatchObject({ total: 0, orphanLocksCleared: 0 })
  })
})

describe('RFC-626 3c: a proven skill and the table ownership', () => {
  test('a proven skill converts identically in both modes; its history copies verbatim', async () => {
    const live = frozenTree(`${HOME}/skills/${SKILL}/files`)
    const snapshot = frozenTree(`${HOME}/skills/${SKILL}/versions/v1/files`)
    const skill = skillSource()
    const version = versionSource({ content_hash: snapshot.contentHash })
    const history = operationSource({
      op_id: 'op-old',
      kind: 'version-write',
      phase: 'done',
      active: 0,
    })
    const fact = skillFact(skill, {
      state: 'proven',
      live,
      versions: [
        {
          id: String(version.values.id),
          version: 1,
          sourceDigest: valueDigest(version.values),
          tree: snapshot,
        },
      ],
    })
    const rows = [skill, version, history]
    const automatic = await convertSkills({
      rows,
      facts: [fact],
      resolution: 'automatic',
      convert: convertFrozenSkillContent,
    })
    const operator = await convertSkills({
      rows,
      facts: [fact],
      convert: convertFrozenSkillContent,
    })
    expect(automatic.output.blocks).toEqual([])
    expect(operator.output.blocks).toEqual([])
    expect(automatic.output.rows).toEqual(operator.output.rows)
    expect(automatic.output.records).toEqual(operator.output.records)
    expect(automatic.output.dispositions).toEqual(operator.output.dispositions)
    expect(automatic.output.artifacts).toEqual(operator.output.artifacts)
    expect(automatic.rows('skills')[0]).toMatchObject({ version_state: 'snapshot-authoritative' })
    expect(automatic.rows('skill_operations')).toEqual(
      await genericCopy([history], 'skill_operations'),
    )
  })

  test('only the skill rule claims skill_operations and skill_operation_locks, as group members', () => {
    const rules = conversionContributions.flatMap((contribution) => contribution.rules)
    for (const table of ['skill_operations', 'skill_operation_locks']) {
      expect(
        rules.filter((rule) => rule.claims.includes(table)).map((rule) => rule.ref.id),
      ).toEqual(['resource-catalog/boot-skills'])
      expect(genericCopyTables as readonly string[]).not.toContain(table)
    }
    const rule = createSkillBootConversion(convertFrozenSkillContent).rules[0]!
    expect(rule.claims).toEqual([
      'skills',
      'skill_versions',
      'skill_operations',
      'skill_operation_locks',
    ])
    expect(rule.produces.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['skill_operations', 'skill_operation_locks']),
    )
    expect(rule.unit).toMatchObject({
      kind: 'group',
      members: [
        { table: 'skills', column: 'id' },
        { table: 'skill_versions', column: 'skill_id' },
        { table: 'skill_operations', column: 'skill_id' },
        { table: 'skill_operation_locks', column: 'locked_skill_id' },
      ],
    })
  })
})

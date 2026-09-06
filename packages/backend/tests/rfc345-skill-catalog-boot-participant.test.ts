import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSkillCatalogBootParticipant } from '../src/modules/resource-catalog/application/skills/skillCatalogBootParticipant'

const sourceRoot = resolve(import.meta.dir, '../src/modules/resource-catalog')
const source = (path: string): string => readFileSync(resolve(sourceRoot, path), 'utf8')

describe('RFC-345 provider-owned Skill Catalog boot participant', () => {
  test('exposes the five ordered boot stages through one frozen nominal capability', async () => {
    const calls: string[] = []
    const participant = createSkillCatalogBootParticipant({
      async runIdentityMigrationBarrier() {
        calls.push('identity')
        return {
          recoveredOperations: 1,
          removedHusks: 2,
          migratedSkills: 3,
          verifiedSkills: 4,
          verifiedVersions: 5,
        }
      },
      activateAvailabilityGate() {
        calls.push('gate')
      },
      async reconcileLiveFiles() {
        calls.push('reconcile')
      },
      async backfillLegacyVersions() {
        calls.push('backfill')
        return { backfilled: 6, husksRemoved: 7 }
      },
      async reverifySnapshots() {
        calls.push('reverify')
        return { verified: 8, quarantined: 9 }
      },
    })

    expect(Object.isFrozen(participant)).toBe(true)
    expect(await participant.runIdentityMigrationBarrier()).toMatchObject({ migratedSkills: 3 })
    participant.activateAvailabilityGate()
    await participant.reconcileLiveFiles()
    expect(await participant.backfillLegacyVersions()).toEqual({ backfilled: 6, husksRemoved: 7 })
    expect(await participant.reverifySnapshots()).toEqual({ verified: 8, quarantined: 9 })
    expect(calls).toEqual(['identity', 'gate', 'reconcile', 'backfill', 'reverify'])
  })

  test('keeps provider clients and transactions outside the closed public surface', () => {
    const participants = source('public/participants.ts')
    const contract = participants.slice(
      participants.indexOf('export interface SkillIdentityMigrationReceipt'),
      participants.indexOf('export interface DemoResourceCatalogSeedMarkerContext'),
    )
    const application = source('application/skills/skillCatalogBootParticipant.ts')
    const brands = source('domain/participantBrands.ts')

    expect(contract).toContain('runIdentityMigrationBarrier()')
    expect(contract).toContain('activateAvailabilityGate()')
    expect(contract).toContain('reconcileLiveFiles()')
    expect(contract).toContain('backfillLegacyVersions()')
    expect(contract).toContain('reverifySnapshots()')
    expect(contract).not.toMatch(/DbClient|DbTx|Postgresql|drizzle|Actor|unknown/)
    expect(brands).toContain('export const skillCatalogBootParticipantBrand: unique symbol')
    expect(application).toContain('[skillCatalogBootParticipantBrand]')
    expect(application).not.toMatch(/as unknown|WeakSet/)
  })

  // RFC-359 W4-D23c：启动状态机也只剩一份——`composeSkillCatalogBoot` 一个入口，两个 daemon 共用，
  // 底下是中立事务的 `legacy/skill*` 崩溃安全机器。PostgreSQL 那份 1418 行原生重写已退役，
  // 它此前还整条略过了身份迁移屏障末尾的引用完整性复核（合一时按「好的那份」补齐）。
  test('boot binds one state machine for both engines, with no provider-native twin', () => {
    const composition = source('composition/skillCatalogBoot.ts')
    const adapter = source('infrastructure/skillCatalogBootAdapter.ts')

    expect(composition).toContain('export function composeSkillCatalogBoot')
    expect(composition).not.toMatch(
      /composeSqliteSkillCatalogBoot|composePostgresqlSkillCatalogBoot/,
    )
    expect(adapter).toContain('runSkillIdentityMigrationBarrier(input.db, input)')
    expect(adapter).toContain('reconcileSkillLiveFiles(input.db, input)')
    expect(adapter).toContain('backfillLegacySkillVersions(input.db, input)')
    expect(adapter).toContain('runBootSnapshotReverify(input.db, input)')
    expect(adapter).toContain('ProviderNeutralDatabase')
    expect(adapter).not.toMatch(/\bDbClient\b|PostgresqlDatabaseClient|createSqlite|fallback/)

    expect(
      existsSync(resolve(sourceRoot, 'infrastructure', 'postgresqlSkillCatalogBoot.ts')),
      'postgresqlSkillCatalogBoot.ts must stay retired',
    ).toBe(false)
  })
})

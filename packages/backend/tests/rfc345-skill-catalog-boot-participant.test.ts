import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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

  test('binds real SQLite and PostgreSQL state machines without fallback or aliases', () => {
    const composition = source('composition/skillCatalogBoot.ts')
    const sqlite = source('infrastructure/sqliteSkillCatalogBoot.ts')
    const postgresql = source('infrastructure/postgresqlSkillCatalogBoot.ts')

    expect(composition).toContain('composeSqliteSkillCatalogBoot')
    expect(composition).toContain('composePostgresqlSkillCatalogBoot')
    expect(sqlite).toContain('runSkillIdentityMigrationBarrier(input.db, input)')
    expect(sqlite).toContain('reconcileSkillLiveFiles(input.db, input)')
    expect(sqlite).toContain('backfillLegacySkillVersions(input.db, input)')
    expect(sqlite).toContain('runBootSnapshotReverify(input.db, input)')

    expect(postgresql).toContain('runPostgresqlResourceCatalogTransaction')
    expect(postgresql).toContain('.from(skillOperations)')
    expect(postgresql).toContain('.from(skillVersions)')
    expect(postgresql).toContain('fingerprintTree')
    expect(postgresql).toContain('hashRegularFileTree')
    expect(postgresql).not.toMatch(/DbClient|createSqlite|as unknown|as DbClient|fallback|no-op/)
  })
})

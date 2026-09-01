import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { decodeSkillZipArchive } from '../src/modules/resource-catalog/infrastructure/skillZipArchive'

const SOURCE_ROOT = resolve(import.meta.dir, '../src/modules/resource-catalog')

function source(relativePath: string): string {
  return readFileSync(resolve(SOURCE_ROOT, relativePath), 'utf8')
}

describe('RFC-345 Skill ZIP provider-neutral participant', () => {
  test('archive decoding stays provider-neutral and preserves normalized bytes', () => {
    const archive = zipSync({
      'demo/SKILL.md': strToU8('---\nname: demo\ndescription: Demo\n---\nBody\n'),
      'demo/reference/info.txt': strToU8('support file'),
    })
    const entries = decodeSkillZipArchive(archive)

    expect(entries.map((entry) => entry.path)).toEqual(['demo/SKILL.md', 'demo/reference/info.txt'])
    expect(new TextDecoder().decode(entries[1]?.bytes())).toBe('support file')
  })

  test('application owns base64 decoding and exposes no provider client', () => {
    const application = source('application/skills/skillZipImport.ts')
    const ports = source('application/skills/ports.ts')

    expect(application).toContain('createSkillZipImportParticipant')
    expect(application).toContain("Buffer.from(submission.content, 'base64')")
    expect(application).not.toMatch(/DbClient|PostgresqlDatabaseClient|@\/db|drizzle-orm/)
    expect(ports).toContain('export interface SkillZipImportPort')
    expect(ports).not.toMatch(/DbClient|PostgresqlDatabaseClient|@\/db|drizzle-orm/)
  })

  test('SQLite is an explicit legacy adapter while PostgreSQL is owner-native', () => {
    const sqlite = source('infrastructure/sqliteSkillZipImport.ts')
    const postgresql = source('infrastructure/postgresqlSkillZipImport.ts')
    const repository = source('infrastructure/postgresqlSkillRepository.ts')

    expect(sqlite).toContain("from './legacy/skill-zip'")
    expect(sqlite).toContain('createSkillZipImportParticipant(port)')

    expect(postgresql).toContain('createPostgresqlSkillZipImportParticipant')
    expect(postgresql).toContain('runPostgresqlResourceCatalogTransaction')
    expect(postgresql).toContain('prepareImportCreate')
    expect(postgresql).toContain('prepareImportOverwrite')
    expect(postgresql).toContain('plan.commitInTransaction(transaction')
    expect(postgresql).toContain('executePostgresqlSkillVersionPlan')
    for (const fence of [
      'expectedOwnerUserId',
      'expectedVisibility',
      'expectedAclRevision',
      'contentVersion',
      'metaRevision',
    ]) {
      expect(postgresql).toContain(fence)
    }
    expect(postgresql).not.toContain('prepareWriteFile')
    expect(postgresql).not.toMatch(/\.transaction\(/)
    expect(postgresql).not.toMatch(
      /@\/services\/|legacy\/skill-zip|\bDbClient\b|createSqlite|as unknown|as DbClient/,
    )

    expect(repository).toContain('prepareImportCreate(input:')
    expect(repository).toContain('prepareImportOverwrite(input:')
    expect(repository).toContain('databaseCommitted = true')
    expect(repository).toContain('await plan.publish()')
    expect(repository).toContain('await plan.abort({ databaseCommitted })')
  })
})

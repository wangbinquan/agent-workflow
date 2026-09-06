import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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

  // RFC-359 W4-D23c：ZIP 导入不再有 provider 孪生——一份适配器（`skillZipImportAdapter.ts`）
  // 套中立事务的 `legacy/skill-zip` 机器，两个数据库共用。此前 PostgreSQL 那份 546 行原生实现
  // （连同它依赖的 postgresqlSkillRepository.ts）已退役。
  test('ZIP import has exactly one adapter and no provider-native twin', () => {
    const adapter = source('infrastructure/skillZipImportAdapter.ts')

    expect(adapter).toContain("from './legacy/skill-zip'")
    expect(adapter).toContain('createParticipant(Object.freeze(port))')
    expect(adapter).toContain('ProviderNeutralDatabase')
    expect(adapter).not.toMatch(/\bDbClient\b|PostgresqlDatabaseClient|createSqlite|as unknown/)

    for (const retired of ['postgresqlSkillZipImport.ts', 'postgresqlSkillRepository.ts']) {
      expect(
        existsSync(resolve(SOURCE_ROOT, 'infrastructure', retired)),
        `${retired} must stay retired`,
      ).toBe(false)
    }
  })
})

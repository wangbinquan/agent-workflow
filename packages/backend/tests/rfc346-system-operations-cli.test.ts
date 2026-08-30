// RFC-346 — source locks for the CLI cutover. Behavioral output remains covered
// by RFC-213 restore tests; this file prevents direct legacy orchestration from
// growing back into the CLI adapters.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_ROOT = join(import.meta.dirname, '../src')
const CLI_ROOT = join(SOURCE_ROOT, 'cli')

describe('RFC-346 CLI typed cutover', () => {
  test('backup and restore consume only exact System Operations public contracts', () => {
    const expectedPublicContracts = {
      'backup.ts': ['commands', 'types'],
      'restore.ts': ['commands', 'queries', 'types'],
    } as const
    for (const [name, contracts] of Object.entries(expectedPublicContracts)) {
      const source = readFileSync(join(CLI_ROOT, name), 'utf8')
      for (const contract of contracts) {
        expect(source).toContain(`@/modules/system-operations/public/${contract}`)
      }
      expect(source).not.toContain('@/modules/system-operations/composition')
      expect(source).not.toMatch(/@\/(?:db|services|util\/(?:lock|paths|migrationsFolder))/)
    }
  })

  test('the real CLI process root owns local composition and injects both adapters', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'main.ts'), 'utf8')
    expect(source).toContain("from './modules/system-operations/composition'")
    expect(source).toContain('backupCommand(Bun.argv.slice(3), requireLocalSystemOperations())')
    expect(source).toContain('restoreCommand(Bun.argv.slice(3), requireLocalSystemOperations())')
  })

  test('RFC-295 downgrade audit remains an explicit direct compatibility command', () => {
    const source = readFileSync(join(CLI_ROOT, 'rfc295-downgrade-audit.ts'), 'utf8')
    expect(source).not.toContain('modules/system-operations')
    expect(source).toContain('readonly: true')
  })
})

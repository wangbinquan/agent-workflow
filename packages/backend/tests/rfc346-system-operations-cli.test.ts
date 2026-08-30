// RFC-346 — source locks for the CLI cutover. Behavioral output remains covered
// by RFC-213 restore tests; this file prevents direct legacy orchestration from
// growing back into the CLI adapters.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLI_ROOT = join(import.meta.dirname, '../src/cli')

describe('RFC-346 CLI typed cutover', () => {
  test('backup and restore call only the System Operations composition', () => {
    for (const name of ['backup.ts', 'restore.ts']) {
      const source = readFileSync(join(CLI_ROOT, name), 'utf8')
      expect(source).toContain('@/modules/system-operations/composition')
      expect(source).not.toMatch(/@\/(?:db|services|util\/(?:lock|paths|migrationsFolder))/)
    }
  })

  test('RFC-295 downgrade audit remains an explicit direct compatibility command', () => {
    const source = readFileSync(join(CLI_ROOT, 'rfc295-downgrade-audit.ts'), 'utf8')
    expect(source).not.toContain('modules/system-operations')
    expect(source).toContain('readonly: true')
  })
})

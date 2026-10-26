// RFC-395 II-b R2: head-digest CI guard and activated shared-compiler boundary, with mutation negative controls.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { verifySchemaHistory } from '@/platform/persistence/schema/history/artifacts'
import { r2Registry, parentTable } from '../helpers/rfc395R2Schema'

const root = resolve(import.meta.dir, '../../../..')
describe('RFC-395 R2 contract-history guard', () => {
  test('the check-mode guard ties the last artifact to the compiled registry, with a negative control', () => {
    const registry = r2Registry()
    const baseline = createHistoryVersion({ registry, slug: 'baseline' })
    expect(() => verifySchemaHistory([baseline], registry)).not.toThrow()
    expect(() => verifySchemaHistory([baseline], r2Registry([parentTable]))).toThrow(
      'registry-head-mismatch',
    )
    expect(() =>
      verifySchemaHistory(
        [{ ...baseline, postgresql: { ...baseline.postgresql, head: [] } }],
        registry,
      ),
    ).toThrow('digest-mismatch')
  })
  test('activation loads artifacts and delegates provider DDL to the shared compilers', () => {
    const head = readFileSync(
      resolve(root, 'packages/backend/src/bootstrap/persistenceHead.ts'),
      'utf8',
    )
    expect(head).toContain('readSchemaHistoryFiles')
    expect(head).not.toContain('createHistoryVersion')
    expect(head).not.toContain("from './persistenceSchema'")
    const compiler = readFileSync(
      resolve(root, 'packages/backend/src/platform/persistence/schema/history/compiler.ts'),
      'utf8',
    )
    expect(compiler).toContain('compileSqliteHistoryRebuild')
    expect(compiler).toContain('compilePostgresqlHistoryAlter')
    expect(compiler).not.toContain('function renderHistoryColumn')
    expect(compiler).not.toContain('function sqliteRebuild')
    expect(compiler).not.toContain('function pgAlter')
  })
})

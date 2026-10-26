// RFC-395 A-3: committed/embedded history must describe the single live registry and PG major catalogs.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  persistenceHead,
  persistenceHistory,
  persistencePostgresqlCatalogs,
  persistencePostgresqlMajors,
} from '@/bootstrap/persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import { compileContract } from '@/platform/persistence/schema/contract'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  verifySchemaHistory,
  generateHistoryBaseline,
  generatePostgresqlCatalogArtifacts,
  readSchemaHistory,
  readPostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/artifacts'
import {
  postgresqlCatalogLoader,
  HistoryCatalogCache,
  verifyPostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/catalog'
import { HISTORY_META_TABLES } from '@/platform/persistence/schema/history/meta'
import { r2Registry } from './helpers/rfc395R2Schema'

const root = resolve(import.meta.dir, '../../..')
const backend = join(root, 'packages/backend')
describe('RFC-395 A-3 activated schema artifacts', () => {
  test('embedded head equals the compiled live registry and both provider plans', () => {
    const head = persistenceHead()
    expect(head.contract.contract.digest).toBe(compileContract(persistenceSchema).digest)
    expect(() => verifySchemaHistory(persistenceHistory(), persistenceSchema)).not.toThrow()
    expect(Object.isFrozen(head)).toBe(true)
    expect(Object.isFrozen(head.sqlite.head)).toBe(true)
    expect(persistenceHead()).toBe(head)
    const broken = { ...head, sqlite: { ...head.sqlite, head: [] } }
    expect(() => verifySchemaHistory([broken], persistenceSchema)).toThrow('digest-mismatch')
  })
  test('PG 17 catalog binds the plan, all 21 meta tables, and the native catalog', async () => {
    const head = persistenceHead(17)
    const artifact = head.postgresqlCatalog!
    const majors = persistencePostgresqlMajors()
    expect(majors).toContain(17)
    expect(majors).toEqual(
      [...new Set(persistencePostgresqlCatalogs().map((entry) => entry.postgresqlMajor))].sort(
        (a, b) => a - b,
      ),
    )
    const unsupportedMajor = Math.max(...majors) + 1
    expect(EPOCH2_META_TABLES).toHaveLength(21)
    expect(artifact.metaDigest).toBe(digestSchemaContract(EPOCH2_META_TABLES))
    expect(artifact.planDigest).toBe(head.postgresql.digest)
    expect(artifact.postgresqlMajor).toBe(17)
    verifyPostgresqlCatalogArtifact(artifact, head.postgresql, EPOCH2_META_TABLES, 17)
    expect(
      artifact.catalog
        .filter(
          (entry) => entry.kind === 'relation' && entry.relation.startsWith('agent_workflow_meta.'),
        )
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...EPOCH2_META_TABLES.map((table) => table.name), 'schema_migrations'].sort())
    expect(() =>
      verifyPostgresqlCatalogArtifact(artifact, head.postgresql, HISTORY_META_TABLES, 17),
    ).toThrow('catalog-artifact-identity')
    expect(() => persistenceHead(unsupportedMajor)).toThrow('catalog-postgresql-major')
    const cache = new HistoryCatalogCache(postgresqlCatalogLoader(persistencePostgresqlCatalogs()))
    expect(await cache.expected(head.postgresql, EPOCH2_META_TABLES, 17)).toEqual(artifact.catalog)
    await expect(
      cache.expected(head.postgresql, EPOCH2_META_TABLES, unsupportedMajor),
    ).rejects.toThrow('catalog-artifact-missing')
  })
  test('one generator call adds a major without rewriting the existing catalog', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'a3-catalog-majors-'))
    try {
      generateHistoryBaseline(directory, r2Registry())
      const head = readSchemaHistory(directory)[0]!
      const compile = (major: number) => async () => {
        const payload = {
          formatVersion: 1 as const,
          schemaEpoch: 2 as const,
          version: head.contract.version,
          planDigest: head.postgresql.digest,
          metaDigest: digestSchemaContract(HISTORY_META_TABLES),
          postgresqlMajor: major,
          catalog: [],
        }
        return { ...payload, digest: digestSchemaContract(payload) }
      }
      const first = await generatePostgresqlCatalogArtifacts({
        directory,
        check: false,
        compile: compile(17),
      })
      const bytes = readFileSync(first[0]!, 'utf8')
      const added = await generatePostgresqlCatalogArtifacts({
        directory,
        check: false,
        compile: compile(18),
      })
      expect(added.map((path) => path.slice(directory.length + 1))).toEqual([
        '0000_baseline.postgresql-18-catalog.json',
      ])
      expect(readFileSync(first[0]!, 'utf8')).toBe(bytes)
      expect(
        readPostgresqlCatalogArtifact(directory, head, HISTORY_META_TABLES, 18).postgresqlMajor,
      ).toBe(18)
      expect(readSchemaHistory(directory, 17)[0]!.postgresqlCatalog!.postgresqlMajor).toBe(17)
      expect(readdirSync(directory)).toHaveLength(5)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test('tooling removal keeps epoch-1 maintenance explicit and CI checks the live history', () => {
    const pkg = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.devDependencies).not.toHaveProperty('drizzle-kit')
    expect(pkg.scripts).not.toHaveProperty('db:generate')
    expect(pkg.scripts).not.toHaveProperty('db:check')
    expect(pkg.scripts['db:epoch1-contract']).toContain('migration/legacy/scripts/')
    expect(pkg.scripts['db:epoch1-postgresql-schema']).toContain('migration/legacy/scripts/')
    expect(readFileSync(join(root, 'bun.lock'), 'utf8')).not.toContain('"drizzle-kit"')
    expect(readFileSync(join(backend, 'tsconfig.json'), 'utf8')).not.toContain('drizzle.config')
    for (const path of [
      'drizzle.config.ts',
      'src/db/schema.ts',
      'scripts/fixup-rfc052-stuck-review.ts',
      'scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts',
      'scripts/fixup-rfc230-misreaped-runs.ts',
      'scripts/rfc349-postgresql-schema.ts',
      'scripts/rfc349-schema-contract.ts',
    ])
      expect(existsSync(join(backend, path))).toBe(false)
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('bun run scripts/schema-history.ts --check')
    expect(ci).not.toContain('drizzle-kit check')
    for (const name of ['rfc349-schema-contract.ts', 'rfc349-postgresql-schema.ts']) {
      const script = readFileSync(
        join(backend, 'src/platform/persistence/migration/legacy/scripts', name),
        'utf8',
      )
      expect(script).toContain('buildFrozenEpoch1LogicalSchemaContract')
      expect(script).not.toContain('bootstrap/persistenceSchema')
    }
    expect(readFileSync(join(root, 'scripts/perf-run.ts'), 'utf8')).toContain(
      'logicalSchemaContract',
    )
  })
})

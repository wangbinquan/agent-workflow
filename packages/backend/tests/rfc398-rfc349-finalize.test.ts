// RFC-398 §4/§7.6: captured release outputs are the oracle, not the current runner.
import { expect, test } from 'bun:test'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  createLegacyMigrationFinalize,
  type LegacyFinalizeStep,
} from '@/modules/system-operations/infrastructure/epochSwitch/legacyMigrationFinalize'
import {
  DATABASE_MIGRATION_PHASES,
  markDatabaseFirstLiveWrite,
  verifyDatabaseMigrationManifest,
  type DatabaseMigrationManifest,
} from '@/modules/system-operations/domain/databaseMigration'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  digestDatabaseArtifact,
  writeDatabaseGenerationAtomic,
} from '@/platform/persistence/generationStore'
import { legacyEpochMigrationCommand } from '@/cli/epochMigrationLegacy'
import {
  decodeCopyTextField,
  describeRfc398Postgresql,
  pgQuote,
  plainDumpChunks,
  rfc398Postgresql,
} from './helpers/rfc398Postgresql'

const fixtures = join(import.meta.dirname, 'fixtures/release-upgrade/rfc349-finalize')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const persistManifest = (path: string, manifest: DatabaseMigrationManifest) => {
  const value = { payload: manifest.payload, digest: digestSchemaContract(manifest.payload) }
  writeFileSync(path, canonicalSchemaJson(verifyDatabaseMigrationManifest(value)))
  return value
}
async function fixture(tag: string) {
  const f = await rfc398Postgresql()
  try {
    const capture = read(join(fixtures, tag, 'capture.json')) as { operationId: string }
    const database = await f.create()
    await f.restore(database.database, join(fixtures, tag, 'before/postgres.sql.gz'))
    const appHome = join(f.root, 'home')
    cpSync(join(fixtures, tag, 'before/home'), appHome, { recursive: true })
    const operationRoot = join(appHome, 'database-migrations', capture.operationId)
    const manifestPath = join(operationRoot, 'manifest.json')
    const rawBefore = verifyDatabaseMigrationManifest(read(manifestPath))
    const rawAfter = verifyDatabaseMigrationManifest(
      read(
        join(fixtures, tag, 'after/home/database-migrations', capture.operationId, 'manifest.json'),
      ),
    )
    const fingerprint = (await f.runtime(database.database).readiness()).databaseFingerprint
    // Preserve captured IDs, source identity, source/artifact paths and checkpoint times: finalize never opens those paths.
    // Only the live target fingerprint changes. Recompute envelope/previous/pointer digests, never mask them.
    const before = persistManifest(manifestPath, {
      ...rawBefore,
      payload: {
        ...rawBefore.payload,
        target: { ...rawBefore.payload.target, databaseFingerprint: fingerprint },
      },
    })
    const pointer = read(join(appHome, 'database-generation.json'))
    writeDatabaseGenerationAtomic({
      pointerPath: join(appHome, 'database-generation.json'),
      payload: {
        ...pointer.payload,
        manifestDigest: digestDatabaseArtifact(readFileSync(manifestPath)),
      },
    })
    const env = { ...process.env, AW_PG_URL: database.url, AGENT_WORKFLOW_HOME: appHome }
    // `-unwritten` captures (gate r1 P2-8): no PostgreSQL first write, so finalize advances
    // straight from `before`; otherwise status first refreshes firstLiveWriteAt.
    const unwritten = rawAfter.payload.firstLiveWriteAt === null
    const previousDigest = unwritten
      ? before.digest
      : markDatabaseFirstLiveWrite(before, {
          expectedRevision: before.payload.revision,
          ownerId: before.payload.owner.id,
          ownerFence: before.payload.owner.fence,
          now: rawAfter.payload.firstLiveWriteAt!,
        }).digest
    const expectedPayload = {
      ...rawAfter.payload,
      target: { ...rawAfter.payload.target, databaseFingerprint: fingerprint },
      previousDigest,
    }
    const expected = { payload: expectedPayload, digest: digestSchemaContract(expectedPayload) }
    const options = { appHome, env, now: () => rawAfter.payload.updatedAt }
    return {
      ...f,
      database,
      appHome,
      operationId: capture.operationId,
      operationRoot,
      manifestPath,
      before,
      expected,
      options,
      rawAfter,
      tag,
      unwritten,
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
async function assertEquivalent(f: Awaited<ReturnType<typeof fixture>>) {
  const actual = verifyDatabaseMigrationManifest(read(f.manifestPath))
  expect(actual).toEqual(f.expected)
  const receipt = read(join(f.operationRoot, 'receipt.json'))
  const expectedReceipt = read(
    join(fixtures, f.tag, 'after/home/database-migrations', f.operationId, 'receipt.json'),
  )
  expect(receipt).toEqual(expectedReceipt)
  expect(actual.payload.receiptDigest).toBe(
    digestDatabaseArtifact(readFileSync(join(f.operationRoot, 'receipt.json'))),
  )
  const pointer = read(join(f.appHome, 'database-generation.json'))
  const expectedPointer = read(join(fixtures, f.tag, 'after/home/database-generation.json'))
  expectedPointer.payload.manifestDigest = digestDatabaseArtifact(readFileSync(f.manifestPath))
  expectedPointer.digest = digestSchemaContract(expectedPointer.payload)
  expect(pointer).toEqual(expectedPointer)
  expect(pointer.payload.version).toBe(1)
  const oracle = await f.create()
  await f.restore(oracle.database, join(fixtures, f.tag, 'after/postgres.sql.gz'))
  const tables = await oracle.sql.unsafe(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('agent_workflow','agent_workflow_meta') AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
  )
  for (const table of tables) {
    const name = `${pgQuote(String(table.table_schema))}.${pgQuote(String(table.table_name))}`
    // JSON text preserves every field, including bigint values, without JavaScript numeric coercion.
    const sql = `SELECT row_to_json(row)::text AS value FROM ${name} AS row ORDER BY row_to_json(row)::text COLLATE "C"`
    expect(await f.database.sql.unsafe(sql)).toEqual(await oracle.sql.unsafe(sql))
  }
}

const CAPTURES = ['v0.18.19', 'v0.19.2', 'v0.18.19-unwritten', 'v0.19.2-unwritten'] as const
describeRfc398Postgresql('RFC-398 epoch-1 finalize release equivalence', () => {
  for (const tag of CAPTURES) {
    test(`${tag}: refresh first-write, finalize, replay preserve every captured field and v1 pointer`, async () => {
      const f = await fixture(tag)
      try {
        const adapter = createLegacyMigrationFinalize(f.options)
        const status = await adapter.status(f.operationId)
        expect(status.phase).toBe('accepting-writes')
        expect(status.firstLiveWriteAt).toBe(f.rawAfter.payload.firstLiveWriteAt)
        expect(read(join(f.appHome, 'database-generation.json')).payload.version).toBe(1)
        await adapter.finalize(f.operationId)
        const bytes = readFileSync(f.manifestPath)
        await adapter.finalize(f.operationId)
        expect(readFileSync(f.manifestPath)).toEqual(bytes)
        await assertEquivalent(f)
      } finally {
        await f.close()
      }
    }, 180_000)

    for (const step of [
      // Without a first write there is no refresh, so these two points are never reached.
      ...(tag.endsWith('-unwritten') ? [] : (['first-write-manifest', 'status-pointer'] as const)),
      'final-receipt',
      'target-finalized',
      'finalized-manifest',
      'finalized-pointer',
    ] as const satisfies readonly LegacyFinalizeStep[]) {
      test(`${tag}: interrupted after ${step} replays to identical captured finalize output`, async () => {
        const f = await fixture(tag)
        try {
          const adapter = createLegacyMigrationFinalize({
            ...f.options,
            afterPersist(point) {
              if (point === step) throw new Error(`interrupted:${step}`)
            },
          })
          await expect(adapter.finalize(f.operationId)).rejects.toThrow(`interrupted:${step}`)
          await createLegacyMigrationFinalize(f.options).finalize(f.operationId)
          await assertEquivalent(f)
        } finally {
          await f.close()
        }
      }, 180_000)
    }
    test(`${tag}: all non-accepting phases and rolled-back operations refuse finalize`, async () => {
      const f = await fixture(tag)
      try {
        for (const phase of DATABASE_MIGRATION_PHASES.filter(
          (phase) => !['accepting-writes', 'finalized'].includes(phase),
        )) {
          persistManifest(f.manifestPath, { ...f.before, payload: { ...f.before.payload, phase } })
          await expect(
            createLegacyMigrationFinalize(f.options).finalize(f.operationId),
          ).rejects.toMatchObject({ code: 'rfc349-operation-unfinished' })
        }
        persistManifest(f.manifestPath, {
          ...f.before,
          payload: {
            ...f.before.payload,
            rolledBackAt: 123,
            rollbackReceiptDigest: digestSchemaContract('rollback'),
          },
        })
        await expect(
          createLegacyMigrationFinalize(f.options).finalize(f.operationId),
        ).rejects.toMatchObject({ code: 'rfc349-operation-unfinished' })
      } finally {
        await f.close()
      }
    }, 120_000)
    test(`${tag}: CLI status/finalize route to epoch-1 adapter and never emit v2`, async () => {
      const f = await fixture(tag)
      try {
        for (const verb of ['status', 'finalize']) {
          const child = Bun.spawn(
            [
              process.execPath,
              resolve(import.meta.dirname, '../src/main.ts'),
              'db',
              'migration',
              verb,
              f.operationId,
              '--json',
            ],
            {
              cwd: resolve(import.meta.dirname, '..'),
              env: f.options.env,
              stdout: 'pipe',
              stderr: 'pipe',
            },
          )
          const [exit, out, err] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect({ exit, err }).toEqual({ exit: 0, err: '' })
          expect(JSON.parse(out).phase).toBe(verb === 'status' ? 'accepting-writes' : 'finalized')
          expect(read(join(f.appHome, 'database-generation.json')).payload.version).toBe(1)
        }
        expect(
          (
            await legacyEpochMigrationCommand({
              ...f.options,
              createApplication: () => createLegacyMigrationFinalize(f.options),
              argv: ['finalize', f.operationId, '--json'],
            })
          )?.status,
        ).toBe('ok')
      } finally {
        await f.close()
      }
    }, 180_000)
  }
})

// The captured release dumps are restored without a native psql (neither lane ships one); the
// decoder must reproduce COPY text format exactly or every equivalence oracle above is void.
test('plain-dump fixtures decode COPY text format and keep SQL between data blocks', () => {
  expect(decodeCopyTextField('\\N')).toBeNull()
  expect(decodeCopyTextField('a\\tb\\nc\\\\d\\x41\\101\\q')).toBe('a\tb\nc\\dAAq')
  expect(decodeCopyTextField('\\\\x0102')).toBe('\\x0102')
  expect(() => decodeCopyTextField('\\xff')).toThrow('unsupported COPY byte escape')
  expect(() => decodeCopyTextField('dangling\\')).toThrow('dangling COPY escape')
  const chunks = plainDumpChunks(
    [
      '\\restrict abc',
      'SET standard_conforming_strings = on;',
      'COPY s.t (a, b) FROM stdin;',
      "1\tit's",
      '2\t\\N',
      '\\.',
      "SELECT pg_catalog.setval('s.q', 2, true);",
      '\\unrestrict abc',
    ].join('\n'),
  )
  expect(chunks).toEqual([
    { kind: 'sql', text: 'SET standard_conforming_strings = on;' },
    {
      kind: 'copy',
      target: 's.t (a, b)',
      rows: [
        ['1', "it's"],
        ['2', null],
      ],
    },
    { kind: 'sql', text: "SELECT pg_catalog.setval('s.q', 2, true);" },
  ])
  expect(() => plainDumpChunks('COPY s.t (a) FROM stdin;\n1')).toThrow('unterminated COPY block')
  for (const tag of CAPTURES)
    for (const side of ['before', 'after']) {
      const dump = gunzipSync(readFileSync(join(fixtures, tag, side, 'postgres.sql.gz'))).toString()
      const blocks = plainDumpChunks(dump).filter((chunk) => chunk.kind === 'copy')
      expect(blocks.length).toBe((dump.match(/^COPY .+ FROM stdin;$/gm) ?? []).length)
      expect(blocks.some((chunk) => chunk.rows.length > 0)).toBe(true)
    }
})

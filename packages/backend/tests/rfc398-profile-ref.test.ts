// RFC-398-T2 / §3.6: one profile grammar through schemas, plans, restart and URL resolution.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import {
  environmentPostgresqlProfileRef,
  isPostgresqlProfileRef,
  parsePostgresqlProfileRef,
} from '@/platform/persistence/postgresqlProfileRef'
import {
  EpochSourceLocationSchema,
  EpochTargetLocationSchema,
  EpochSwitchInputsSchema,
  createEpochSwitchJournal,
  parseEpochSwitchJournal,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  ActivationReceiptPayloadSchema,
  MigrationPlanDocumentPayloadSchema,
  parseMigrationPlanDocument,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import {
  environmentProfile,
  resolveEpochProfile,
} from '@/modules/system-operations/domain/epochSwitch/supportMatrix'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import type { EpochSwitchPlanInput } from '@/modules/system-operations/public/types'
import { pointerConfiguration } from '@/platform/persistence/databaseProviderRuntime'
import type { GenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type PostgresqlPoolOptions,
} from '@/platform/persistence/postgresqlRuntime'
import { postgresqlRuntimeFor } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { describeRfc398Postgresql } from './helpers/rfc398Postgresql'
import { postgresqlAutoUpgradeFixture } from './helpers/rfc398AutoUpgradePostgresql'
import { businessRoundTrip } from './helpers/rfc398AutoUpgrade'
import { makeSwitchFixture, fixtureDigest } from './helpers/rfc395V3SwitchFixture'

const derived = 'env:SOURCE_URL/target_%E5%BA%93%3F%23%25'
const databaseName = 'target_库?#%'
const invalid = [
  '',
  'env:',
  'env:1NAME',
  'env:HAS-DASH',
  'env:HAS SPACE',
  'env:URL\n',
  'ENV:URL',
  'postgresql://host/db',
  'env:URL/',
  'env:URL/a/b',
  'env:URL/a%2Fb',
  'env:URL/a b',
  'env:URL/a%20b',
  'env:URL/a%09b',
  'env:URL/%E3%80%80',
  'env:URL/%00',
  'env:URL/%',
  'env:URL/%GG',
  'env:URL/%FF',
  'env:URL/raw库',
  'env:URL/a?b',
  'env:URL/%61',
  'env:URL/%e5%ba%93',
  `env:URL/${'a'.repeat(64)}`,
  `env:URL/${encodeURIComponent('库'.repeat(22))}`,
  'crewstation:scratch',
]

function pointer(profileRef: string): GenerationPointerV2 {
  const payload: GenerationPointerV2['payload'] = {
    version: 2,
    schemaEpoch: 2,
    generationId: 'dbg_rfc398_target',
    provider: 'postgresql',
    role: 'installed',
    database: { kind: 'postgresql-target', profileRef },
    contractDigest: fixtureDigest,
    planDigest: fixtureDigest,
    operationId: null,
    manifestDigest: null,
    activatedAt: 1,
    previous: null,
  }
  return { payload, digest: digestSchemaContract(payload) }
}

function capturePools() {
  const options: PostgresqlPoolOptions[] = []
  const factory = (input: PostgresqlPoolOptions): PostgresqlPool => {
    options.push(input)
    return {
      async reserve() {
        throw new Error('This test must not connect to PostgreSQL')
      },
      unsafe() {
        throw new Error('This test must not query PostgreSQL')
      },
      async close() {},
    }
  }
  return { options, factory }
}

function assertUrl(value: string, expectedDatabase: string) {
  const url = new URL(value)
  expect(decodeURIComponent(url.pathname.slice(1))).toBe(expectedDatabase)
  expect(url.protocol).toBe('postgresql:')
  expect(url.hostname).toBe('db.example.test')
  expect(url.port).toBe('5433')
  expect(url.username).toBe('user%40name')
  expect(url.password).toBe('pass%3Aword')
  expect(url.searchParams.get('sslmode')).toBe('require')
  expect(url.searchParams.get('application_name')).toBe('profile test')
  expect(url.searchParams.getAll('tag')).toEqual(['one', 'two'])
  expect(url.searchParams.get('options')).toContain('-c work_mem=8MB')
}
const env = {
  SOURCE_URL:
    'postgresql://user%40name:pass%3Aword@db.example.test:5433/original?sslmode=require&application_name=profile%20test&tag=one&tag=two&options=-c%20work_mem%3D8MB',
}

describe('profile grammar and all durable validation points', () => {
  test('plain refs and canonical encoded database names round-trip with byte limits', () => {
    expect(parsePostgresqlProfileRef('env:_URL_123')).toEqual({ kind: 'env', urlEnv: '_URL_123' })
    expect(parsePostgresqlProfileRef(derived)).toEqual({
      kind: 'env',
      urlEnv: 'SOURCE_URL',
      databaseName,
    })
    for (const name of [
      'a',
      '.',
      '..',
      'a'.repeat(63),
      '库'.repeat(21),
      databaseName,
      "a!'()*:@+%",
    ])
      expect(parsePostgresqlProfileRef(environmentPostgresqlProfileRef('URL', name))).toEqual({
        kind: 'env',
        urlEnv: 'URL',
        databaseName: name,
      })
    expect(environmentProfile('SOURCE_URL')).toBe('env:SOURCE_URL')
    for (const name of ['', '1VAR', 'VAR/name', 'VAR\n']) {
      expect(() => environmentProfile(name)).toThrow('v3-invalid-url-environment-name')
      expect(() => environmentPostgresqlProfileRef(name)).toThrow()
    }
    for (const name of ['', 'a/b', 'a b', '\0', '库'.repeat(22)])
      expect(() => environmentPostgresqlProfileRef('URL', name)).toThrow()
  })

  const sourceSchemas = [
    EpochSourceLocationSchema,
    MigrationPlanDocumentPayloadSchema.shape.source.shape.location,
    ActivationReceiptPayloadSchema.shape.source.shape.location,
  ]
  const targetSchemas = [
    EpochTargetLocationSchema,
    MigrationPlanDocumentPayloadSchema.shape.target.shape.location,
    ActivationReceiptPayloadSchema.shape.target.shape.location,
  ]
  const scratchSchemas = [
    EpochSwitchInputsSchema.shape.scratchProfileRef,
    MigrationPlanDocumentPayloadSchema.shape.scratchProfileRef,
  ]
  test('source, target, scratch, plan and activation retain the existing hosted role boundaries', () => {
    for (const schema of sourceSchemas) {
      for (const profileRef of ['env:URL', derived, 'crewstation:source'])
        expect(schema.safeParse({ kind: 'postgresql-database', profileRef }).success).toBe(true)
      expect(
        schema.safeParse({ kind: 'postgresql-database', profileRef: 'crewstation:target' }).success,
      ).toBe(false)
    }
    for (const schema of targetSchemas) {
      for (const profileRef of ['env:URL', derived, 'crewstation:target'])
        expect(schema.safeParse({ kind: 'postgresql-target', profileRef }).success).toBe(true)
      expect(
        schema.safeParse({ kind: 'postgresql-target', profileRef: 'crewstation:source' }).success,
      ).toBe(false)
    }
    for (const schema of scratchSchemas) {
      for (const profileRef of [null, 'env:URL', derived])
        expect(schema.safeParse(profileRef).success).toBe(true)
      for (const profileRef of ['crewstation:source', 'crewstation:target'])
        expect(schema.safeParse(profileRef).success).toBe(false)
    }
    expect(parsePostgresqlProfileRef('crewstation:source')).toEqual({
      kind: 'crewstation',
      role: 'source',
    })
    expect(parsePostgresqlProfileRef('crewstation:target')).toEqual({
      kind: 'crewstation',
      role: 'target',
    })
    expect(resolveEpochProfile({ profileRef: 'crewstation:target' }, 'target')).toBe(
      'crewstation:target',
    )
  })
  for (const profileRef of invalid)
    test(`reject malformed profile ${JSON.stringify(profileRef)} at every boundary`, () => {
      expect(parsePostgresqlProfileRef(profileRef)).toBeNull()
      expect(isPostgresqlProfileRef(profileRef)).toBe(false)
      for (const schema of sourceSchemas)
        expect(schema.safeParse({ kind: 'postgresql-database', profileRef }).success).toBe(false)
      for (const schema of targetSchemas)
        expect(schema.safeParse({ kind: 'postgresql-target', profileRef }).success).toBe(false)
      for (const schema of scratchSchemas) expect(schema.safeParse(profileRef).success).toBe(false)
      expect(() => resolveEpochProfile({ profileRef })).toThrow('v3-invalid-postgresql-profile-ref')
      expect(() => pointerConfiguration({ provider: 'sqlite' }, pointer(profileRef))).toThrow(
        'epoch2-postgresql-profile-must-reference-env',
      )
      expect(() =>
        postgresqlRuntimeFor({ profileRef, base: null, generationId: 'dbg_test', env }),
      ).toThrow('postgresql-profile-reference-invalid')
    })
})

test('generation pointers and migration runtimes override only the database path', async () => {
  const base = PostgresqlDatabaseConfigSchema.parse({
    provider: 'postgresql',
    urlEnv: 'STALE',
    databaseName: 'stale',
    poolMax: 7,
  })
  const config = pointerConfiguration(base, pointer(derived))
  expect(config).toMatchObject({ urlEnv: 'SOURCE_URL', databaseName, poolMax: 7 })
  if (config.provider !== 'postgresql') throw new Error('expected PostgreSQL')
  const capture = capturePools()
  const runtime = createPostgresqlDatabaseRuntime({
    config,
    generationId: 'dbg_test',
    env,
    poolFactory: capture.factory,
  })
  const migration = postgresqlRuntimeFor({
    profileRef: derived,
    base,
    generationId: 'dbg_test',
    env,
    poolFactory: capture.factory,
  })
  try {
    runtime.providerPool('migration')
    expect(capture.options).toHaveLength(4) // online + migration pools for both runtimes
    for (const options of capture.options) {
      assertUrl(options.url, databaseName)
      expect(options.database).toBe(databaseName)
    }
    expect(capture.options.map((options) => options.max)).toEqual([7, 7, 7, 7])
    expect(env.SOURCE_URL).toContain('/original?')
  } finally {
    await runtime.close()
    await migration.close()
  }
  const plain = pointerConfiguration(base, pointer('env:SOURCE_URL'))
  expect(plain).toMatchObject({ urlEnv: 'SOURCE_URL' })
  expect(plain.provider === 'postgresql' ? plain.databaseName : null).toBeUndefined()
  const legacyCapture = capturePools()
  const legacy = postgresqlRuntimeFor({
    profileRef: 'env:SOURCE_URL',
    base,
    generationId: 'dbg_test',
    env,
    poolFactory: legacyCapture.factory,
  })
  try {
    for (const options of legacyCapture.options) assertUrl(options.url, 'original')
  } finally {
    await legacy.close()
  }
  for (const profileRef of ['crewstation:source', 'crewstation:target']) {
    expect(() => pointerConfiguration(base, pointer(profileRef))).toThrow(
      'epoch2-postgresql-profile-must-reference-env',
    )
    expect(() => postgresqlRuntimeFor({ profileRef, base, generationId: 'dbg_test', env })).toThrow(
      'postgresql-profile-reference-invalid',
    )
  }
})

test('dot-segment database names reach the driver even when URL parsing normalizes their path', async () => {
  for (const databaseName of ['.', '..']) {
    const capture = capturePools()
    const runtime = postgresqlRuntimeFor({
      profileRef: environmentPostgresqlProfileRef('SOURCE_URL', databaseName),
      base: null,
      generationId: 'dbg_test',
      env,
      poolFactory: capture.factory,
    })
    try {
      expect(capture.options).toHaveLength(2)
      for (const options of capture.options) {
        expect(options.database).toBe(databaseName)
        expect(new URL(options.url).hostname).toBe('db.example.test')
        expect(new URL(options.url).searchParams.get('sslmode')).toBe('require')
      }
    } finally {
      await runtime.close()
    }
  }
})

test('derived target and scratch survive plan persistence and a new application instance', async () => {
  const f = makeSwitchFixture()
  try {
    const scratchProfileRef = 'env:SOURCE_URL/scratch_%E5%BA%93'
    const view = await f.app.plan({
      target: { provider: 'postgresql', profileRef: derived },
      scratchProfileRef,
    })
    const journalAfterPlan = (await f.deps.journal.read(f.operationId))!
    expect(journalAfterPlan.payload.target.location).toEqual({
      kind: 'postgresql-target',
      profileRef: derived,
    })
    expect(journalAfterPlan.payload.inputs.scratchProfileRef).toBe(scratchProfileRef)
    const document = parseMigrationPlanDocument(readFileSync(view.jsonPath!, 'utf8'))
    expect(document.payload.target.location).toEqual(journalAfterPlan.payload.target.location!)
    expect(document.payload.scratchProfileRef).toBe(scratchProfileRef)
    const journal = createEpochSwitchJournal({
      ...journalAfterPlan.payload,
      source: {
        ...journalAfterPlan.payload.source,
        provider: 'postgresql',
        location: { kind: 'postgresql-database', profileRef: 'env:SOURCE_URL/source_%E5%BA%93' },
      },
    })
    expect(parseEpochSwitchJournal(JSON.stringify(journal))).toEqual(journal)
    const restarted = createEpochSwitchApplication(f.deps)
    const reread = await restarted.plan({ operationId: f.operationId })
    expect(reread.plan.payload.target.location).toEqual(journalAfterPlan.payload.target.location!)
    expect(reread.plan.payload.scratchProfileRef).toBe(scratchProfileRef)
    const scratchOnly = await restarted.plan({
      operationId: f.operationId,
      scratchProfileRef: 'env:SOURCE_URL/scratch_only',
    })
    expect(scratchOnly.plan.payload.target.location).toEqual(reread.plan.payload.target.location)
    expect(scratchOnly.plan.payload.scratchProfileRef).toBe('env:SOURCE_URL/scratch_only')
    const changed = await restarted.plan({
      operationId: f.operationId,
      target: { provider: 'postgresql', profileRef: 'env:SOURCE_URL/next_target' },
      scratchProfileRef: 'env:SOURCE_URL/next_scratch',
    })
    expect(changed.plan.payload.target.location).toEqual({
      kind: 'postgresql-target',
      profileRef: 'env:SOURCE_URL/next_target',
    })
    expect(changed.plan.payload.scratchProfileRef).toBe('env:SOURCE_URL/next_scratch')
    const legacy = await restarted.plan({
      operationId: f.operationId,
      target: { provider: 'postgresql', urlEnv: 'TARGET_URL' },
      scratchUrlEnv: 'SCRATCH_URL',
    })
    expect(legacy.plan.payload.target.location).toEqual({
      kind: 'postgresql-target',
      profileRef: 'env:TARGET_URL',
    })
    expect(legacy.plan.payload.scratchProfileRef).toBe('env:SCRATCH_URL')
  } finally {
    f.close()
  }
})

test('restore replay retains a derived target and refuses a different profile', async () => {
  const f = makeSwitchFixture()
  try {
    f.deps.unpackBackup = async () => ({
      sourceKind: 'sqlite-backup',
      root: f.root,
      digest: fixtureDigest,
    })
    const request = {
      artifact: 'rfc398-backup',
      target: { provider: 'postgresql' as const, profileRef: derived },
    }
    const planned = await f.app.restoreBackup(request)
    expect(planned.plan.payload.target.location).toEqual({
      kind: 'postgresql-target',
      profileRef: derived,
    })
    expect((await f.app.restoreBackup(request)).plan.digest).toBe(planned.plan.digest)
    await expect(
      f.app.restoreBackup({
        ...request,
        target: { provider: 'postgresql', profileRef: 'env:SOURCE_URL/another_database' },
      }),
    ).rejects.toThrow('v3-restore-input-conflict')
  } finally {
    f.close()
  }
})

for (const input of [
  { target: { provider: 'postgresql', urlEnv: 'URL', profileRef: derived } },
  {
    target: { provider: 'postgresql', profileRef: derived },
    scratchUrlEnv: 'URL',
    scratchProfileRef: 'env:URL/scratch',
  },
  { target: { provider: 'postgresql', profileRef: 'env:URL/' } },
  {
    target: { provider: 'postgresql', profileRef: derived },
    scratchProfileRef: 'crewstation:source',
  },
])
  test(`planner refuses conflicting or invalid inputs before discovery: ${JSON.stringify(input)}`, async () => {
    const f = makeSwitchFixture()
    try {
      await expect(f.app.plan(input as unknown as EpochSwitchPlanInput)).rejects.toThrow()
      expect(await f.deps.journal.list()).toEqual([])
      expect(f.control.installed).toBe(false)
    } finally {
      f.close()
    }
  })

describeRfc398Postgresql('profileRef full process chain', () => {
  test('derived ref → plan → process exit → journal restart → run → verify → daemon business read/write', async () => {
    const f = await postgresqlAutoUpgradeFixture()
    try {
      f.barriers(['phase-planned'])
      const parent = f.start()
      const child = await f.reached('phase-planned')
      const before = f.journals()[0]!
      expect(before.payload.target.location).toMatchObject({
        kind: 'postgresql-target',
        profileRef: `env:RFC398_URL/${f.source.database}_epoch2`,
      })
      expect(before.payload.inputs.scratchProfileRef).toBe(
        `env:RFC398_URL/${f.source.database}_epoch2_scratch`,
      )
      f.kill(child.pid)
      f.kill(parent.process.pid)
      await parent.exited
      f.release('phase-planned')
      const resume = f.spawn(['db', 'migration', 'auto', '--json'])
      expect(await resume.exited).toBe(0)
      const after = f.journals()[0]!
      expect(after.payload.phase).toBe('verified')
      expect(after.payload.target.location).toEqual(before.payload.target.location)
      expect(f.allocations()).toHaveLength(2)
      const pointer = JSON.parse(readFileSync(`${f.home}/database-generation.json`, 'utf8'))
      expect(pointer.payload.database).toEqual(after.payload.target.location)
      f.start()
      await f.ready()
      await businessRoundTrip(f)
      expect(f.sessions()).toHaveLength(1)
      // Implementation gate r1 P2-6 (§3.5): status names the retained target and scratch with
      // their size and purpose for an automatic PostgreSQL session.
      const status = f.spawn(['db', 'migration', 'status', after.payload.operationId, '--json'])
      expect(await status.exited).toBe(0)
      const view = JSON.parse(status.output) as {
        mode?: string
        retainedDatabases?: { kind: string; database: string; bytes: number; purpose: string }[]
      }
      expect(view.mode).toBe('auto')
      expect((view.retainedDatabases ?? []).map((row) => [row.kind, row.database]).sort()).toEqual([
        ['scratch', `${f.source.database}_epoch2_scratch`],
        ['target', `${f.source.database}_epoch2`],
      ])
      expect(view.retainedDatabases!.every((row) => row.bytes > 0 && row.purpose.length > 0)).toBe(
        true,
      )
    } finally {
      await f.close()
    }
  }, 240_000)
})

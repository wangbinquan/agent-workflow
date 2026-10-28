import { expect, setDefaultTimeout, test } from 'bun:test'
import { SQL } from 'bun'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigurationValue } from '@/platform/configuration/configurationValues'
import {
  composeLocalEpochSwitch,
  composeLocalEpochSwitchDependencies,
  type LocalEpochSwitchOptions,
} from '@/bootstrap/epochMigration'
import { composeHostedEpochJobEntry } from '@/bootstrap/epochMigrationHostedEntry'
import { runHostedEpochSwitchJob, verifyHostedEpochSwitch } from '@/bootstrap/epochMigrationHosted'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import type { EpochSwitchPlanView } from '@/modules/system-operations/public/types'
import {
  describeV3Providers,
  describeV3CrossProvider,
  type V3Harness,
} from './helpers/rfc395V3Harness'
import { createRfc395FixtureDatabase } from './helpers/rfc395FixturePostgresql'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'

// These entry journeys compile all frozen catalogs, convert, restart and verify on real PG.
setDefaultTimeout(120_000)

async function productionOptions(h: V3Harness) {
  const base = process.env[resolvePostgresqlTestUrlEnv(process.env)!]!
  const scratch = await createRfc395FixtureDatabase(base)
  const sourceUrl = new URL(base)
  if (h.sourceProvider === 'postgresql')
    sourceUrl.pathname = `/${(await h.source.sourceHarness.native.execute('SELECT current_database() AS name'))[0]!.name}`
  const targetUrl = new URL(base)
  targetUrl.pathname = `/${(await h.target.execute('SELECT current_database() AS name'))[0]!.name}`
  const env = {
    ...process.env,
    CIC_SOURCE_URL: sourceUrl.toString(),
    CIC_TARGET_URL: targetUrl.toString(),
    CIC_SCRATCH_URL: scratch.url,
  }
  const options: LocalEpochSwitchOptions = {
    appHome: h.appHome,
    config: resolveConfigurationValue(
      h.sourceProvider === 'postgresql'
        ? { database: { provider: 'postgresql', urlEnv: 'CIC_SOURCE_URL' } }
        : {},
    ),
    env,
    head: persistenceHead(),
    catalogArtifacts: persistencePostgresqlCatalogs(),
    sourceBornOnPostgresql: true,
  }
  return { options, env, scratch }
}
const planInput = {
  target: { provider: 'postgresql' as const, urlEnv: 'CIC_TARGET_URL' },
  scratchUrlEnv: 'CIC_SCRATCH_URL',
}
function catalogFile(h: V3Harness, operationId: string): string {
  const root = join(h.appHome, 'database-migrations', operationId, 'source-catalogs')
  const files = readdirSync(root)
  expect(files).toHaveLength(1)
  return join(root, files[0]!)
}
async function runAndVerify(options: LocalEpochSwitchOptions, plan: EpochSwitchPlanView) {
  expect(plan.plan.payload.blocks).toEqual([])
  // Separate compositions model separate CLI invocations; neither injects a manifest.
  expect(
    (
      await composeLocalEpochSwitch(options).run({
        operationId: plan.operationId,
        approve: plan.plan.approvalDigest,
      })
    ).phase,
  ).toBe('activated')
  expect(
    (await composeLocalEpochSwitch(options).verify({ operationId: plan.operationId })).phase,
  ).toBe('verified')
}

describeV3Providers('production epoch-1 PostgreSQL source manifest', (h) => {
  if (h.sourceProvider !== 'postgresql') return

  test('default local composition identifies, freezes, converts and verifies the real source', async () => {
    await h.source.install()
    await seedRequiredRows(h.source)
    const { options, scratch } = await productionOptions(h)
    const reference = new SQL(scratch.url, { max: 1 })
    try {
      const before = await h.source.sourceHarness.fingerprint()
      const plan = await composeLocalEpochSwitch(options).plan(planInput)
      expect(plan.plan.payload.source.provider).toBe('postgresql')
      expect(plan.plan.payload.source.sourceVersion).toStartWith('postgresql:')
      expect(existsSync(catalogFile(h, plan.operationId))).toBe(true)
      expect(
        await reference.unsafe(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'agent_workflow%'",
        ),
      ).toHaveLength(0)
      await runAndVerify(options, plan)
      expect(await h.source.sourceHarness.fingerprint()).toEqual(before)
      expect(readGenerationPointerV2(h.pointerPath).payload).toMatchObject({
        provider: 'postgresql',
        schemaEpoch: 2,
        role: 'converted',
        operationId: plan.operationId,
      })
    } finally {
      await reference.close()
      await scratch.drop()
    }
  })

  test('bound old PostgreSQL backup uses the same manifest before journal creation and at run', async () => {
    const version = await h.source.install()
    await seedRequiredRows(h.source)
    const backup = await h.source.sourceHarness.backup(version)
    const { options, scratch } = await productionOptions(h)
    try {
      expect(existsSync(join(backup.artifactRoot, 'source-evidence/binding.json'))).toBe(true)
      const plan = await composeLocalEpochSwitch(options).restoreBackup({
        ...planInput,
        artifact: backup.artifactRoot,
      })
      expect(plan.plan.payload.role).toBe('restored')
      expect(plan.plan.payload.source.provider).toBe('postgresql')
      await runAndVerify(options, plan)
      expect(readGenerationPointerV2(h.pointerPath).payload.role).toBe('restored')
    } finally {
      backup.close()
      await scratch.drop()
    }
  })

  test('default composition refuses occupied references, unknown physical catalogs and changed cache', async () => {
    await h.source.install()
    const { options, scratch } = await productionOptions(h)
    const reference = new SQL(scratch.url, { max: 1 })
    const request = {
      scratchOwner: 'dbm_e2_production_negative',
      scratchProfileRef: 'env:CIC_SCRATCH_URL',
      location: { kind: 'postgresql-database' as const, profileRef: 'env:CIC_SOURCE_URL' },
      operationRoot: join(h.appHome, 'negative-source'),
      emptyTables: [],
    }
    const discover = () => composeLocalEpochSwitchDependencies(options).source.discover(request)
    try {
      const before = await h.source.sourceHarness.fingerprint()
      await reference.unsafe('CREATE TABLE public.occupied_reference (id integer)')
      await expect(discover()).rejects.toThrow('scratch-not-empty')
      expect(await h.source.sourceHarness.fingerprint()).toEqual(before)
      await reference.unsafe('DROP TABLE public.occupied_reference')
      const source = await discover()
      await source.close()
      const path = catalogFile(h, request.scratchOwner)
      const bytes = readFileSync(path)
      await h.source.sourceHarness.native.execute(
        'ALTER TABLE agent_workflow.maintenance_state ADD COLUMN unknown_catalog_column text',
      )
      await expect(discover()).rejects.toMatchObject({ category: 'source-blocked' })
      const stored = JSON.parse(bytes.toString('utf8'))
      stored.payload.postgresqlMajor += 1
      writeFileSync(path, JSON.stringify(stored))
      await expect(discover()).rejects.toThrow('reference catalog cache differs')
    } finally {
      await reference.close()
      await scratch.drop()
    }
  })

  test('real hosted entry persists its reference catalogs across Job scratch loss, run and verify', async () => {
    await h.source.install('pre-seq')
    await seedRequiredRows(h.source)
    const { env, scratch } = await productionOptions(h)
    const artifacts = new Map<string, { bytes: string; digest: string }>()
    let pointsAt = 'source'
    let prepared = false
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith('/artifacts')) {
          if (request.method === 'GET')
            return Response.json(artifacts.get(url.searchParams.get('name')!) ?? null)
          // CrewStation refuses callback bodies above 32 MiB (CrewStation repository,
          // modules/release/http/databaseMigrationCallbacks.ts:9). The reference catalogs alone are
          // about 37 MiB; written as one document they failed the first hosted plan on CrewStation
          // (RFC-395 T19 / CS RFC-044 T9 acceptance, 2026-10-28).
          const text = await request.text()
          if (Buffer.byteLength(text) > 32 * 1024 * 1024)
            return Response.json(
              { error: 'validation', message: '迁移回调请求超过 32 MiB', details: {} },
              { status: 413 },
            )
          const body = JSON.parse(text) as { name: string; bytes: string; digest: string }
          const previous = artifacts.get(body.name)
          if (previous && previous.digest !== body.digest)
            return Response.json({ error: 'write-once-conflict' }, { status: 409 })
          const bytes = Buffer.from(body.bytes, 'base64')
          expect(bytesDigest(bytes)).toBe(body.digest)
          artifacts.set(body.name, { bytes: body.bytes, digest: body.digest })
          return Response.json({ digest: body.digest, bytes: bytes.length })
        }
        if (url.pathname.endsWith('/freeze/verify')) return Response.json({ verified: true })
        if (url.pathname.endsWith('/prepared')) {
          prepared = true
          return Response.json({})
        }
        if (url.pathname.endsWith('/activation'))
          return Response.json({ pointsAt, pointerDigest: null })
        return Response.json(
          { error: 'unexpected-control-request', path: url.pathname },
          { status: 400 },
        )
      },
    })
    const jobEnv = {
      CS_DATABASE_MIGRATION_OPERATION_ID: 'dbm_e2_production_hosted',
      CS_DATABASE_MIGRATION_SOURCE_URL: env.CIC_SOURCE_URL,
      CS_DATABASE_MIGRATION_TARGET_URL: env.CIC_TARGET_URL,
      CS_DATABASE_MIGRATION_SCRATCH_URL: scratch.url,
      CS_DATABASE_MIGRATION_SOURCE_GENERATION: 'dbg_hosted_source',
      CS_DATABASE_MIGRATION_SOURCE_BORN_ON_POSTGRESQL: '1',
      CS_DATABASE_MIGRATION_FREEZE_REFERENCE: 'fixture-freeze',
      CS_DATABASE_MIGRATION_CONTROL_URL: server.url.toString(),
      CS_DATABASE_MIGRATION_SCRATCH_ROOT: join(h.appHome, 'job-one'),
    }
    try {
      const line = await runHostedEpochSwitchJob(jobEnv, composeHostedEpochJobEntry(jobEnv))
      const plan = JSON.parse(line.slice(line.indexOf('=') + 1)) as EpochSwitchPlanView
      expect(plan.plan.payload.blocks).toEqual([])
      expect(plan.plan.payload.source.provider).toBe('postgresql')
      const catalogNames = [...artifacts.keys()].filter((name) =>
        name.startsWith('source-catalogs/'),
      )
      expect(catalogNames).toHaveLength(1)
      const originalCatalog = artifacts.get(catalogNames[0]!)
      // The name holds a small pointer; the catalogs are chunked in the artifact port.
      const pointer = JSON.parse(
        Buffer.from(originalCatalog!.bytes, 'base64').toString('utf8'),
      ) as {
        digest: string
      }
      const chunks = [...artifacts.entries()].filter(([name]) =>
        name.startsWith(`.artifacts/${catalogNames[0]}.content/${pointer.digest.slice(7)}/`),
      )
      expect(chunks.length).toBeGreaterThan(2)
      for (const [, chunk] of chunks)
        expect(Buffer.from(chunk.bytes, 'base64').byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
      const upgraded = new SQL(scratch.url, { max: 1 })
      try {
        expect(
          (await upgraded.unsafe("SELECT to_regclass('agent_workflow.node_runs') AS name"))[0]!
            .name,
        ).not.toBeNull()
      } finally {
        await upgraded.close()
      }
      rmSync(jobEnv.CS_DATABASE_MIGRATION_SCRATCH_ROOT, { recursive: true, force: true })
      const resumed = {
        ...jobEnv,
        CS_DATABASE_MIGRATION_SCRATCH_ROOT: join(h.appHome, 'job-two'),
        CS_DATABASE_MIGRATION_ACTION: 'run',
        CS_DATABASE_MIGRATION_APPROVE: plan.plan.approvalDigest,
      }
      expect(
        await runHostedEpochSwitchJob(resumed, composeHostedEpochJobEntry(resumed)),
      ).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
      expect(prepared).toBe(true)
      pointsAt = 'target'
      expect(
        await verifyHostedEpochSwitch(resumed, composeHostedEpochJobEntry(resumed)),
      ).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
      expect(artifacts.get(catalogNames[0]!)).toEqual(originalCatalog)
    } finally {
      await server.stop(true)
      await scratch.drop()
    }
  })
})

describeV3CrossProvider('production SQLite-origin artifact with PostgreSQL scratch', (h) => {
  test('default restore composition identifies the upgraded scratch and reopens it at run', async () => {
    const version = await h.source.install('pre-seq')
    const backup = await h.source.sourceHarness.backup(version)
    const { options, scratch } = await productionOptions(h)
    try {
      const plan = await composeLocalEpochSwitch(options).restoreBackup({
        ...planInput,
        artifact: backup.artifactRoot,
      })
      expect(plan.plan.payload.source.provider).toBe('sqlite')
      expect(plan.plan.payload.source.location).toMatchObject({
        kind: 'backup',
        sourceKind: 'logical-artifact',
      })
      const catalog = readFileSync(catalogFile(h, plan.operationId))
      await runAndVerify(options, plan)
      expect(readFileSync(catalogFile(h, plan.operationId))).toEqual(catalog)
      expect(readGenerationPointerV2(h.pointerPath).payload.role).toBe('restored')
    } finally {
      backup.close()
      await scratch.drop()
    }
  })
})

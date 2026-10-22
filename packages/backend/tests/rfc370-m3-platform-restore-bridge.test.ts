import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { createCrewStationObjectReader } from '@/platform/crewstation/objectStorage'
import { restoreCrewStationDatabaseFromEnvironment } from '@/modules/system-operations/composition/crewstationDatabaseRestore'

test('platform restore generation is stable across Jobs and serving, distinct from the retained installation', () => {
  const installation = { project: 'restore-test', service: 'app', schemaDigest: 'a'.repeat(64) }
  const original = hostedDatabaseGeneration(installation)
  const env = {
    CS_DATABASE_GENERATION_ID: '01a13e6d-3e00-7000-9e3c-000000000001',
    CS_DATABASE_GENERATION_OPERATION: '01a13e6d-3e00-7000-9e3c-000000000002',
  }
  const restored = hostedDatabaseGeneration({ ...installation, env })
  expect(restored.payload.generationId).not.toBe(original.payload.generationId)
  expect(
    hostedDatabaseGeneration({
      ...installation,
      env: { ...env, CS_DATABASE_RESTORE_REFERENCE: 'unused-in-serving-identity' },
    }),
  ).toEqual(restored)
  expect(() =>
    hostedDatabaseGeneration({
      ...installation,
      env: { CS_DATABASE_GENERATION_ID: env.CS_DATABASE_GENERATION_ID },
    }),
  ).toThrow('identity-invalid')
  expect(hostedDatabaseGeneration({ ...installation, env: {} })).toEqual(original)
})

test('restore object reader carries only the original Bearer authority and still verifies complete bytes', async () => {
  const bytes = 'immutable backup',
    sha256 = createHash('sha256').update(bytes).digest('hex')
  const requests: {
    url: string
    method: string | undefined
    headers: Headers
    redirect: string | undefined
  }[] = []
  const reader = createCrewStationObjectReader({
    baseUrl: 'http://cs-api:8087/internal/database-restore-objects/original',
    token: 'original-read-token',
    fetch: Object.assign(
      async (raw: string | Request | URL, init?: RequestInit) => {
        requests.push({
          url: String(raw),
          method: init?.method,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        })
        return new Response(bytes, {
          headers: { 'x-cs-object-sha256': sha256, 'content-length': String(bytes.length) },
        })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  })
  expect(
    await new Response(
      await reader.open({
        id: '01a13e6d-3e00-7000-9e3c-000000000003',
        sha256,
        size: bytes.length,
      }),
    ).text(),
  ).toBe(bytes)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toEndWith('/original/01a13e6d-3e00-7000-9e3c-000000000003/content')
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer original-read-token')
  expect(requests[0]!.redirect).toBe('error')
  expect(Object.keys(reader).sort()).toEqual(['open', 'stat'])
})

// RFC-370 v3 V5: the platform restore reference is the only restore input; the
// former AW_RESTORE_OBJECT release-Job input no longer starts a restore.
test('only the platform restore reference starts a restore, and only with its platform identity', async () => {
  const environment = { project: 'test', service: 'app' }
  await expect(
    restoreCrewStationDatabaseFromEnvironment({
      contract: buildLogicalSchemaContract(),
      environment,
      env: { AW_RESTORE_OBJECT: 'aw-object:v1:database-backup:legacy' },
      normalization: [],
    }),
  ).resolves.toBeUndefined()
  await expect(
    restoreCrewStationDatabaseFromEnvironment({
      contract: buildLogicalSchemaContract(),
      environment,
      env: { CS_DATABASE_RESTORE_REFERENCE: 'platform' },
      normalization: [],
    }),
  ).rejects.toThrow('platform-identity-missing')
  await expect(
    restoreCrewStationDatabaseFromEnvironment({
      contract: buildLogicalSchemaContract(),
      environment,
      env: {
        CS_DATABASE_RESTORE_REFERENCE: 'not-a-reference',
        CS_DATABASE_GENERATION_ID: '01a13e6d-3e00-7000-9e3c-000000000001',
        CS_DATABASE_GENERATION_OPERATION: '01a13e6d-3e00-7000-9e3c-000000000002',
        CS_DATABASE_RESTORE_OPERATION: '01a13e6d-3e00-7000-9e3c-000000000002',
        CS_OBJECTS_TOKEN: 'token',
      },
      normalization: [],
    }),
  ).rejects.toThrow('hosted-object-reference-invalid')
})

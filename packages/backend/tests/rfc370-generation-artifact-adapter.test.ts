// RFC-370 A-T2 — storage-independent generation validation must retain the
// standalone pointer/manifest/schema/recovery decisions. Existing RFC-349
// tests continue to exercise atomic replacement and crash recovery on disk.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DatabaseGenerationError,
  digestDatabaseArtifact,
  digestGenerationPayload,
  readDatabaseGenerationFromArtifacts,
  readDatabaseGenerationForBootstrapFromArtifacts,
  type DatabaseGenerationArtifactReader,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import { createFileDatabaseGenerationArtifacts } from '@/platform/persistence/generationStore'

const current = `sha256:${'a'.repeat(64)}`
const historical = `sha256:${'b'.repeat(64)}`
const operationId = 'dbm_adapter_operation'
const manifest = Buffer.from('{"phase":"finalized"}\n')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function payload(schemaDigest = current): DatabaseGenerationPayload {
  return {
    version: 1,
    generationId: 'dbg_adapter_generation',
    provider: 'postgresql',
    operationId,
    schemaDigest,
    manifestDigest: digestDatabaseArtifact(manifest),
    activatedAt: 17,
  }
}

function serialize(value: DatabaseGenerationPayload): string {
  return JSON.stringify({ payload: value, digest: digestGenerationPayload(value) })
}

function readers(pointer: string | null, manifestBytes: Uint8Array | null) {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-generation-artifacts-'))
  roots.push(root)
  const pointerPath = join(root, 'generation.json')
  const migrationsDir = join(root, 'operations')
  if (pointer !== null) writeFileSync(pointerPath, pointer)
  if (manifestBytes !== null) {
    mkdirSync(join(migrationsDir, operationId), { recursive: true })
    writeFileSync(join(migrationsDir, operationId, 'manifest.json'), manifestBytes)
  }
  const snapshot: DatabaseGenerationArtifactReader = {
    pointerLabel: 'installation-snapshot',
    readPointer: () => pointer,
    readManifest: (id) => (id === operationId ? manifestBytes : null),
  }
  return [snapshot, createFileDatabaseGenerationArtifacts({ pointerPath, migrationsDir })]
}

function codeOf(action: () => unknown): string {
  try {
    action()
    throw new Error('expected a generation validation failure')
  } catch (error) {
    if (!(error instanceof DatabaseGenerationError)) throw error
    return error.code
  }
}

describe('RFC-370 generation artifact source conformance', () => {
  test('missing pointer keeps the legacy SQLite generation for both sources', () => {
    for (const source of readers(null, null)) {
      expect(
        readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current }),
      ).toMatchObject({
        source: 'legacy-missing-pointer',
        payload: { provider: 'sqlite', schemaDigest: current },
      })
    }
  })

  test('current manifest-bound generation preserves every payload field', () => {
    const value = payload()
    for (const source of readers(serialize(value), manifest)) {
      expect(
        readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current }),
      ).toEqual({ source: 'verified-pointer', payload: value })
    }
  })

  test('known history is a bootstrap candidate and cannot enter the strict runtime', () => {
    const value = payload(historical)
    for (const source of readers(serialize(value), manifest)) {
      expect(
        codeOf(() =>
          readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current }),
        ),
      ).toBe('generation-schema-mismatch')
      expect(
        readDatabaseGenerationForBootstrapFromArtifacts(source, {
          expectedSchemaDigest: current,
          supportedSchemaDigests: [historical],
        }),
      ).toEqual({
        kind: 'schema-upgrade',
        payload: value,
        pointerDigest: digestGenerationPayload(value),
      })
    }
  })

  test.each([
    ['malformed JSON', '{', manifest, 'generation-pointer-corrupt'],
    ['invalid shape', '{}', manifest, 'generation-pointer-corrupt'],
    ['missing manifest', serialize(payload()), null, 'generation-manifest-missing'],
    [
      'wrong manifest',
      serialize(payload()),
      Buffer.from('different'),
      'generation-manifest-digest-mismatch',
    ],
    [
      'wrong pointer digest',
      JSON.stringify({ payload: payload(), digest: `sha256:${'c'.repeat(64)}` }),
      manifest,
      'generation-pointer-digest-mismatch',
    ],
  ] as const)(
    '%s is the same typed failure through either source',
    (_name, pointer, bytes, expected) => {
      for (const source of readers(pointer, bytes)) {
        expect(
          codeOf(() =>
            readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current }),
          ),
        ).toBe(expected)
      }
    },
  )

  test('an unknown schema fails before a missing manifest, preserving error precedence', () => {
    for (const source of readers(serialize(payload(historical)), null)) {
      expect(
        codeOf(() =>
          readDatabaseGenerationForBootstrapFromArtifacts(source, {
            expectedSchemaDigest: current,
            supportedSchemaDigests: [],
          }),
        ),
      ).toBe('generation-schema-mismatch')
    }
  })

  test('interrupted recovery requires the owner callback and returns only a candidate', () => {
    const value = payload()
    const changed = Buffer.from('{"phase":"health-checked","label":"恢复"}\n')
    for (const source of readers(serialize(value), changed)) {
      const seen: string[] = []
      const candidate = readDatabaseGenerationForBootstrapFromArtifacts(source, {
        expectedSchemaDigest: current,
        supportedSchemaDigests: [],
        verifyInterruptedOperation(input) {
          expect(input.payload).toEqual(value)
          seen.push(input.manifestText)
        },
      })
      expect(seen).toEqual([changed.toString('utf8')])
      expect(candidate).toEqual({
        kind: 'operation-recovery',
        payload: value,
        pointerDigest: digestGenerationPayload(value),
        recoveryManifestDigest: digestDatabaseArtifact(changed),
      })
      const rejection = new Error('owner rejected recovery')
      expect(() =>
        readDatabaseGenerationForBootstrapFromArtifacts(source, {
          expectedSchemaDigest: current,
          supportedSchemaDigests: [],
          verifyInterruptedOperation: () => {
            throw rejection
          },
        }),
      ).toThrow(rejection)
      expect(
        codeOf(() =>
          readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current }),
        ),
      ).toBe('generation-manifest-digest-mismatch')
    }
  })

  test('a read failure is not a missing pointer and cannot select legacy SQLite', () => {
    const source: DatabaseGenerationArtifactReader = {
      pointerLabel: 'unreadable installation',
      readPointer: () => {
        throw new Error('source unavailable')
      },
      readManifest: () => null,
    }
    expect(
      codeOf(() => readDatabaseGenerationFromArtifacts(source, { expectedSchemaDigest: current })),
    ).toBe('generation-pointer-corrupt')
  })
})

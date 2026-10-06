// RFC-370 A2: selected evidence content drives the actual Mission read faces.
// Bounded range policy remains in the application; file IO has its own adapter.
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/localVerificationCommands'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'
import { composeDevelopmentAutomation } from '@/modules/development-automation/composition'
import { composeDevelopmentMissionOperations } from '@/modules/development-automation/composition/missionOperations'
import {
  EVIDENCE_READ_MAX_BYTES,
  readEvidenceRange,
  type EvidenceContentQueries,
} from '@/modules/development-automation/application/pipelineEvidenceRead'
import {
  canonicalDigest,
  canonicalStringify,
} from '@/modules/development-automation/domain/canonicalJson'
import type { DevelopmentDeliveryProvider } from '@/services/developmentDeliveryDeps'

const roots: string[] = []
const identityRuntimes: ReturnType<typeof createIdentityAccessRuntime>[] = []
afterEach(async () => {
  for (const runtime of identityRuntimes.splice(0)) await runtime.shutdown()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const unused = async (): Promise<never> => {
  throw new Error('reading evidence must not dispatch a delivery effect')
}
const deliveryProvider: DevelopmentDeliveryProvider = {
  resolveRepository: unused,
  resolveBinding: unused,
  readMrFactTarget: unused,
  pipeline: { collect: unused, trigger: unused, rerun: unused },
}

describe('RFC-370 selected evidence range policy', () => {
  test('invalid ranges do not call content, and a selected failure is propagated', async () => {
    let calls = 0
    const failure = new Error('selected range unavailable')
    const contents: EvidenceContentQueries = {
      readText: unused,
      async readRange(input) {
        expect(this).toBe(contents)
        calls += 1
        expect(input).toEqual({
          sha256: 'opaque',
          offsetBytes: 0,
          limitBytes: EVIDENCE_READ_MAX_BYTES,
        })
        throw failure
      },
    }
    for (const input of [
      { offsetBytes: -1, limitBytes: 1 },
      { offsetBytes: 0.5, limitBytes: 1 },
      { offsetBytes: 0, limitBytes: 0 },
      { offsetBytes: 0, limitBytes: Number.NaN },
    ]) {
      expect(await readEvidenceRange(contents, { sha256: 'opaque', ...input })).toEqual({
        ok: false,
        code: 'range-invalid',
      })
    }
    expect(calls).toBe(0)
    await expect(
      readEvidenceRange(contents, {
        sha256: 'opaque',
        offsetBytes: 0,
        limitBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
  })
})

describeEachProvider('RFC-370 selected Mission evidence contents', (harness) => {
  test('actual detail and range operations await the same selected contents and preserve continuation', async () => {
    const fx = await buildPr3Fixture({ db: harness.db })
    await harness.db.insert(users).values({
      id: 'u-1',
      username: 'evidence-reader',
      displayName: 'Evidence reader',
      role: 'admin',
      status: 'active',
      passwordHash: 'fixture',
      createdAt: 1,
      updatedAt: 1,
    })
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    identityRuntimes.push(identityAccess)
    const admitted = await admitTestDirectAuthority(identityAccess.directAuthority, {
      userId: 'u-1',
      source: 'session',
    })
    if (admitted === null) throw new Error('evidence reader authority unavailable')
    const actor = admitted.actor
    const missionId = await fx.launchDirect('selected-evidence-mission')
    const mission = await fx.store.getMission(missionId)
    if (mission === null) throw new Error('expected real mission')
    const ref = 'object:pipeline-manifest'
    const sha256 = 'a'.repeat(64)
    const manifest = {
      schemaVersion: 1,
      bundleId: 'selected-bundle',
      providerKey: 'selected-provider',
      headSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      completeness: 'complete',
      gates: [],
      files: [
        {
          fileId: 'selected-log',
          relativePath: 'log.txt',
          mediaType: 'text/plain',
          bytes: 10,
          sha256,
          redaction: 'none',
        },
      ],
      totals: { files: 1, bytes: 10 },
      redaction: 'complete',
      manifestDigest: 'c'.repeat(64),
    }
    const cells = {
      '__pipeline.manifestRef': { state: 'known' as const, value: ref, sourceRevision: 'selected' },
    }
    await fx.store.insertFactSnapshot({
      id: 'selected-evidence-snapshot',
      missionId,
      missionRevision: mission.revision,
      capturedAt: new Date().toISOString().replace('Z', '+00:00'),
      cellsJson: canonicalStringify(cells),
      refsJson: '{}',
      digest: canonicalDigest(cells),
      now: Date.now(),
    })
    expect(
      await fx.store.occUpdate(missionId, mission.revision, mission.epoch, {
        requirementBundleRef: 'selected-evidence-snapshot',
      }),
    ).toEqual({ ok: true, revision: mission.revision + 1 })
    const textEntered = Promise.withResolvers<void>()
    const textRelease = Promise.withResolvers<void>()
    const rangeEntered = Promise.withResolvers<void>()
    const rangeRelease = Promise.withResolvers<void>()
    let missing = false
    let invalid = false
    let readFailure = false
    let ranges = 0
    const contents: EvidenceContentQueries = {
      async readText(reference) {
        expect(this).toBe(contents)
        expect(reference).toBe(ref)
        textEntered.resolve()
        await textRelease.promise
        if (readFailure) throw new Error('manifest bytes could not be read')
        return missing ? null : invalid ? '{invalid' : JSON.stringify(manifest)
      },
      async readRange(input) {
        expect(this).toBe(contents)
        ranges += 1
        expect(input).toEqual({ sha256, offsetBytes: 4, limitBytes: EVIDENCE_READ_MAX_BYTES })
        rangeEntered.resolve()
        await rangeRelease.promise
        return {
          ok: true,
          bytes: new TextEncoder().encode('EFGH'),
          totalBytes: 10,
          truncated: true,
          nextOffset: 8,
        }
      },
    }
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-selected-evidence-'))
    roots.push(appHome)
    const automation = composeDevelopmentAutomation({
      verificationCommands: createLocalVerificationCommandEffectsFactory(),
      db: harness.db,
      appHome,
      evidenceContents: contents,
    })
    expect(automation.evidenceContents).toBe(contents)
    const operations = composeDevelopmentMissionOperations({
      db: harness.db,
      automation,
      admissionLookup: fx.lookup,
      deliveryProvider,
      legacyAdmissionsEnabled: async () => true,
    })
    const before = await fx.store.getMission(missionId)
    let detailSettled = false
    const detail = operations.get(actor, missionId).finally(() => {
      detailSettled = true
    })
    try {
      await textEntered.promise
      expect(detailSettled).toBe(false)
      expect(await fx.store.getMission(missionId)).toEqual(before)
    } finally {
      textRelease.resolve()
    }
    expect(await detail).toMatchObject({
      pipeline: {
        bundleId: 'selected-bundle',
        headSha: 'a'.repeat(40),
        files: manifest.files.map(({ redaction: _redaction, ...file }) => file),
      },
    })
    let rangeSettled = false
    const range = operations
      .readPipelineEvidence(missionId, sha256, 4, Number.MAX_SAFE_INTEGER)
      .finally(() => {
        rangeSettled = true
      })
    try {
      await rangeEntered.promise
      expect(rangeSettled).toBe(false)
      expect(await fx.store.getMission(missionId)).toEqual(before)
    } finally {
      rangeRelease.resolve()
    }
    expect(await range).toEqual({
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('EFGH'),
      totalBytes: 10,
      truncated: true,
      nextOffset: 8,
    })
    await expect(
      operations.readPipelineEvidence(missionId, 'b'.repeat(64), 0, 10),
    ).rejects.toMatchObject({ code: 'pipeline-evidence-file-not-found' })
    await expect(operations.readPipelineEvidence(missionId, sha256, -1, 10)).rejects.toMatchObject({
      code: 'range-invalid',
    })
    expect(ranges).toBe(1)
    missing = true
    await expect(operations.readPipelineEvidence(missionId, sha256, 0, 10)).rejects.toMatchObject({
      code: 'evidence-blob-missing',
    })
    expect(await operations.get(actor, missionId)).toMatchObject({ pipeline: null })
    missing = false
    invalid = true
    await expect(operations.readPipelineEvidence(missionId, sha256, 0, 10)).rejects.toMatchObject({
      code: 'pipeline-manifest-invalid',
    })
    invalid = false
    readFailure = true
    await expect(operations.readPipelineEvidence(missionId, sha256, 0, 10)).rejects.toMatchObject({
      code: 'pipeline-manifest-invalid',
    })
    expect(await operations.get(actor, missionId)).toMatchObject({ pipeline: null })
    expect(await fx.store.getMission(missionId)).toEqual(before)
  })
})

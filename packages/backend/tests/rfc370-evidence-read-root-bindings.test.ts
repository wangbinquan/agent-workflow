// RFC-370 A2: real Mission HTTP waits for selected document, handle and stream
// ACKs. Range policy and manifest metadata remain with the existing owners.
import { afterEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import type { EvidenceDownloadHandle } from '@/modules/development-automation/application/evidenceDownloads'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import type { RequirementBundleManifestV1 } from '@/modules/development-automation/domain/requirementManifest'
import { sha256Hex } from '@/util/hash'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const unused = (): never => {
  throw new Error('this download must not use pipeline content')
}
const text = 'ABCDEFGHIJ'
const sha256 = sha256Hex(text)
function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}
function inherited(store: EvidenceReadBinding): EvidenceReadBinding {
  class Selection implements EvidenceReadBinding {
    get contents() {
      expect<EvidenceReadBinding>(this).toBe(receiver)
      return store.contents
    }
    get documents() {
      expect<EvidenceReadBinding>(this).toBe(receiver)
      return store.documents
    }
    get downloads() {
      expect<EvidenceReadBinding>(this).toBe(receiver)
      return store.downloads
    }
  }
  const receiver: EvidenceReadBinding = Object.freeze(new Selection())
  expect(Object.keys(receiver)).toEqual([])
  return receiver
}

describeEachProviderHttpApplication(
  'RFC-370 true evidence read root binding',
  {
    token: 'e'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-evidence-root-',
  },
  (scope) => {
    const roots: string[] = []
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })
    const headers = { Authorization: `Bearer ${'e'.repeat(64)}` }
    for (const representation of ['own', 'inherited'] as const) {
      test(`HTTP ${representation} selection waits for all ACKs and retains range, missing and failure results`, async () => {
        const documentEntered = Promise.withResolvers<void>(),
          documentReady = Promise.withResolvers<void>()
        const handleEntered = Promise.withResolvers<void>(),
          handleReady = Promise.withResolvers<void>()
        const streamEntered = Promise.withResolvers<void>(),
          streamReady = Promise.withResolvers<void>()
        type Mode =
          | 'content'
          | 'document-missing'
          | 'document-invalid'
          | 'document-schema'
          | 'document-failure'
          | 'blob-missing'
          | 'blob-failure'
          | 'stream-failure'
        let mode: Mode = 'content',
          documentsRead = 0,
          opened = 0
        const calls: (readonly [number, number] | 'all')[] = []
        const manifest: RequirementBundleManifestV1 = {
          schemaVersion: 1,
          bundleId: 'object:requirement-bundle',
          source: { kind: 'direct', submissionId: 'selected-submission' },
          title: 'Selected requirement',
          fetchedAt: '2026-10-03T00:00:00+00:00',
          complete: true,
          files: [
            {
              fileId: 'file-1',
              ordinal: 0,
              relativePath: 'source.txt',
              role: 'requirement',
              mediaType: 'text/plain',
              bytes: text.length,
              sha256,
              redaction: 'none',
              repositoryPlacement: null,
            },
          ],
          totals: { files: 1, bytes: text.length },
          writebackRef: null,
          manifestDigest: 'c'.repeat(64),
        }
        const handle: EvidenceDownloadHandle = {
          async openAll() {
            expect(this).toBe(handle)
            calls.push('all')
            streamEntered.resolve()
            await streamReady.promise
            if (mode === 'stream-failure') throw new Error('selected stream failed')
            return stream(text)
          },
          async open(start, endInclusive) {
            expect(this).toBe(handle)
            calls.push([start, endInclusive])
            if (mode === 'stream-failure') throw new Error('selected stream failed')
            return stream(text.slice(start, endInclusive + 1))
          },
        }
        const documents: EvidenceReadBinding['documents'] = {
          async readText(input) {
            expect(this).toBe(documents)
            expect(input).toEqual({
              bundleRef: 'object:manifest-document',
              relativePath: 'requirement-manifest.json',
            })
            documentsRead += 1
            documentEntered.resolve()
            await documentReady.promise
            if (mode === 'document-failure') throw new Error('selected document failed')
            if (mode === 'document-missing') return null
            if (mode === 'document-invalid') return '{invalid'
            return mode === 'document-schema' ? '{}' : JSON.stringify(manifest)
          },
        }
        const downloads: EvidenceReadBinding['downloads'] = {
          async open(ref) {
            expect(this).toBe(downloads)
            expect(ref).toBe(sha256)
            opened += 1
            handleEntered.resolve()
            await handleReady.promise
            if (mode === 'blob-failure') throw new Error('selected blob failed')
            return mode === 'blob-missing' ? null : handle
          },
        }
        const store = Object.freeze({
          contents: { readText: unused, readRange: unused },
          documents,
          downloads,
        })
        const selected = representation === 'own' ? store : inherited(store)
        const { app } = await scope.open({ evidenceRead: selected })
        const fx = await buildPr3Fixture({ db: scope.harness.db })
        roots.push(fx.stagingRoot, dirname(dirname(dirname(fx.evidence.blobPath(sha256)))))
        const missionId = await fx.launchDirect(`selected-${representation}`)
        await createRequirementBundleRefPersistence(scope.harness.db).insert({
          id: `manifest-${representation}`,
          missionId,
          purpose: 'requirement-manifest',
          evidenceRef: 'object:manifest-document',
          manifestDigest: manifest.manifestDigest,
          fileCount: 1,
          totalBytes: text.length,
          retentionState: 'active',
          createdAt: Date.now(),
        })
        const before = await fx.store.getMission(missionId)
        const path = `/api/code/missions/${missionId}/requirement-files/${sha256}`
        let settled = false
        const pending = Promise.resolve(app.request(path, { headers })).finally(() => {
          settled = true
        })
        const awaitAck = (ack: Promise<void>) =>
          Promise.race([
            ack,
            pending.then(async (response) => {
              throw new Error(
                `selected evidence ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
        try {
          await awaitAck(documentEntered.promise)
          expect(settled).toBe(false)
          expect(opened).toBe(0)
          expect(await fx.store.getMission(missionId)).toEqual(before)
          documentReady.resolve()
          await awaitAck(handleEntered.promise)
          expect(settled).toBe(false)
          expect(calls).toEqual([])
          handleReady.resolve()
          await awaitAck(streamEntered.promise)
          expect(settled).toBe(false)
          expect(await fx.store.getMission(missionId)).toEqual(before)
          streamReady.resolve()
          const response = await pending
          expect(response.status).toBe(200)
          expect(response.headers.get('content-type')).toBe('text/plain')
          expect(response.headers.get('content-length')).toBe('10')
          expect(response.headers.get('accept-ranges')).toBe('bytes')
          expect(await response.text()).toBe(text)
          expect(calls).toEqual(['all'])
          const manifestResponse = await app.request(
            `/api/code/missions/${missionId}/requirement-manifest`,
            { headers },
          )
          expect(manifestResponse.status).toBe(200)
          expect(await manifestResponse.json()).toEqual({ missionId, manifest })
          for (const [range, start, end, body] of [
            ['bytes=2-5', 2, 5, 'CDEF'],
            ['bytes=7-', 7, 9, 'HIJ'],
            ['bytes=-3', 7, 9, 'HIJ'],
            ['bytes=0-99', 0, 9, text],
          ] as const) {
            const ranged = await app.request(path, { headers: { ...headers, Range: range } })
            expect(ranged.status).toBe(206)
            expect(ranged.headers.get('content-range')).toBe(`bytes ${start}-${end}/10`)
            expect(ranged.headers.get('content-length')).toBe(String(body.length))
            expect(await ranged.text()).toBe(body)
            expect(calls.at(-1)).toEqual([start, end])
          }
          const callsBeforeInvalid = calls.length
          for (const range of ['bytes=', 'bytes=3-2', 'bytes=10-', 'bytes=-0', 'bytes=0-1,3-4']) {
            expect(
              (await app.request(path, { headers: { ...headers, Range: range } })).status,
            ).toBe(416)
            expect(calls).toHaveLength(callsBeforeInvalid)
          }
          for (const [failureMode, status] of [
            ['document-missing', 404],
            ['document-invalid', 500],
            ['document-schema', 404],
            ['document-failure', 500],
            ['blob-missing', 404],
            ['blob-failure', 500],
            ['stream-failure', 500],
          ] as const) {
            mode = failureMode
            const failed = await app.request(path, { headers })
            expect(failed.status).toBe(status)
            expect(await fx.store.getMission(missionId)).toEqual(before)
          }
          mode = 'content'
          const opensBeforeMissing = opened
          const missingMember = await app.request(path.replace(sha256, 'f'.repeat(64)), { headers })
          expect(missingMember.status).toBe(404)
          expect(opened).toBe(opensBeforeMissing)
          expect(documentsRead).toBeGreaterThan(1)
          expect(await fx.store.getMission(missionId)).toEqual(before)
        } finally {
          documentReady.resolve()
          handleReady.resolve()
          streamReady.resolve()
          await pending
        }
      }, 20_000)
    }
  },
)

// RFC-370 A2: real dual-provider HTTP commits answers through the selected writer.
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import type { EvidenceBundleRecord } from '@/modules/development-automation/domain/evidence'
import { DIRECT_SUBMISSION_BUDGET } from '@/modules/development-automation/infrastructure/requirementMaterializer'
import { createFileEvidenceDocumentQueries } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentQueries'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const unused = (): never => {
  throw new Error('this answer request must not read pipeline/download content')
}

describeEachProviderHttpApplication(
  'RFC-370 selected document writer at real HTTP roots',
  {
    token: 'f'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-document-write-root-',
  },
  (scope) => {
    const roots: string[] = []
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })
    for (const representation of ['own', 'inherited'] as const) {
      test(`${representation} receiver waits for answer document ACK before refs and mission mutation`, async () => {
        const entered = Promise.withResolvers<void>()
        const ack = Promise.withResolvers<void>()
        const saved = new Map<string, { relativePath: string; content: string }>()
        const writes: Parameters<EvidenceDocumentCommands['writeDocument']>[0][] = []
        class Writer implements EvidenceDocumentCommands {
          async writeDocument(input: Parameters<EvidenceDocumentCommands['writeDocument']>[0]) {
            expect<EvidenceDocumentCommands>(this).toBe(writer)
            expect(input.budget).toBe(DIRECT_SUBMISSION_BUDGET)
            expect(input.relativePath).toBe('answer-set.json')
            writes.push(input)
            entered.resolve()
            await ack.promise
            const bytes = new TextEncoder().encode(input.content).byteLength
            const result: EvidenceBundleRecord = {
              bundleId: 'object:answer-document',
              entries: [
                {
                  relativePath: input.relativePath,
                  bytes,
                  sha256: createHash('sha256').update(input.content).digest('hex'),
                },
              ],
              totalBytes: bytes,
            }
            saved.set(result.bundleId, { relativePath: input.relativePath, content: input.content })
            return result
          }
        }
        const prototype = new Writer()
        const writer: EvidenceDocumentCommands =
          representation === 'inherited'
            ? Object.freeze(prototype)
            : Object.freeze({ writeDocument: prototype.writeDocument })
        expect(Object.keys(writer)).toEqual(representation === 'inherited' ? [] : ['writeDocument'])
        const documents: EvidenceReadBinding['documents'] = {
          async readText(input) {
            expect(this).toBe(documents)
            const selected = saved.get(input.bundleRef)
            if (selected !== undefined)
              return selected.relativePath === input.relativePath ? selected.content : null
            return await localDocuments.readText(input)
          },
        }
        const opened = await scope.open({
          evidenceDocumentCommands: writer,
          evidenceRead: {
            documents,
            contents: { readText: unused, readRange: unused },
            downloads: { open: unused },
          },
        })
        const fx = await buildPr3Fixture({ db: scope.harness.db })
        roots.push(fx.stagingRoot, dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))))
        const localDocuments = createFileEvidenceDocumentQueries({
          getBundle: (ref) => fx.evidence.getBundle(ref),
          blobPath: (ref) => fx.evidence.blobPath(ref),
        })
        const missionId = await fx.launchDirect(`writer-root-${representation}`)
        const questions = await fx.materializer.stashQuestionSet({
          missionId,
          origin: 'platform',
          channel: 'platform',
          questions: [{ questionId: 'q1', text: 'Which?', answerKind: 'text', choices: null }],
        })
        expect(questions.ok).toBe(true)
        if (!questions.ok) throw new Error('question fixture failed')
        const current = (await fx.store.getMission(missionId))!
        expect(
          (
            await fx.store.occUpdate(missionId, current.revision, current.epoch, {
              status: 'awaiting-information',
            })
          ).ok,
        ).toBe(true)
        const refs = createRequirementBundleRefPersistence(scope.harness.db)
        const beforeMission = await fx.store.getMission(missionId)
        const beforeAnswer = await refs.latest(missionId, 'answer-set')
        const body = JSON.stringify({
          questionSetRef: questions.questionSetRef,
          answers: [{ questionId: 'q1', answer: '中文' }],
        })
        const path = `/api/code/missions/${missionId}/answers`
        const request = () =>
          opened.app.request(path, {
            method: 'POST',
            body,
            headers: {
              Authorization: `Bearer ${'f'.repeat(64)}`,
              'content-type': 'application/json',
            },
          })
        let settled = false
        const pending = Promise.resolve(request()).finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            entered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected writer missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          expect(await refs.latest(missionId, 'answer-set')).toEqual(beforeAnswer)
          expect(await fx.store.getMission(missionId)).toEqual(beforeMission)
          expect(saved.size).toBe(0)
          expect(existsSync(join(opened.appHome, 'evidence', 'staging'))).toBe(false)
        } finally {
          ack.resolve()
        }
        const response = await pending
        expect(response.status, await response.clone().text()).toBe(200)
        const result = (await response.json()) as {
          status: string
          answerSetRef: string
          answerRevision: string
        }
        expect(result.status).toBe('working')
        expect(result.answerRevision).toMatch(/^[0-9a-f]{64}$/)
        expect((await refs.get(result.answerSetRef))?.evidenceRef).toBe('object:answer-document')
        expect((await refs.get(result.answerSetRef))?.totalBytes).toBe(
          new TextEncoder().encode(writes[0]!.content).byteLength,
        )
        expect(JSON.parse(writes[0]!.content)).toMatchObject({
          answers: [{ questionId: 'q1', answer: '中文' }],
        })
        const replay = await request()
        expect(replay.status).toBe(409)
        expect(writes).toHaveLength(1)
        expect(existsSync(join(opened.appHome, 'evidence', 'staging'))).toBe(false)
      }, 20_000)
    }
  },
)

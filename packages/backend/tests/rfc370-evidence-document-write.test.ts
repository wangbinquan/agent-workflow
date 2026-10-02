// RFC-370 A2: durable document ACK precedes bundle-reference and question/answer facts.
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { EvidenceDocumentQueries } from '@/modules/development-automation/application/evidenceDocuments'
import type { EvidenceBundleRecord } from '@/modules/development-automation/domain/evidence'
import { canonicalStringify } from '@/modules/development-automation/domain/canonicalJson'
import {
  createRequirementMaterializer,
  DIRECT_SUBMISSION_BUDGET,
  directSubmissionDigest,
} from '@/modules/development-automation/infrastructure/requirementMaterializer'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-370 selected evidence document writer', (harness) => {
  test('same prototype writer completes before direct/question/answer references, including sync completion and failure', async () => {
    const fx = await buildPr3Fixture({ db: harness.db })
    roots.push(fx.stagingRoot, dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))))
    const missionId = await fx.launchDirect('selected-document-write')
    const refs = createRequirementBundleRefPersistence(harness.db)
    const stagingRoot = join(fx.stagingRoot, 'selected-never-local')
    const saved = new Map<string, { relativePath: string; content: string }>()
    const calls: Parameters<EvidenceDocumentCommands['writeDocument']>[0][] = []
    let entered = Promise.withResolvers<void>()
    let ack = Promise.withResolvers<void>()
    let mode: 'async' | 'sync' | 'failure' = 'async'
    const failure = new Error('selected document commit ACK lost')
    class Writer implements EvidenceDocumentCommands {
      writeDocument(input: Parameters<EvidenceDocumentCommands['writeDocument']>[0]) {
        expect<EvidenceDocumentCommands>(this).toBe(writer)
        expect(input.budget).toBe(DIRECT_SUBMISSION_BUDGET)
        calls.push(input)
        const bundleId = `object:document:${calls.length}`
        const bytes = new TextEncoder().encode(input.content).byteLength
        const result: EvidenceBundleRecord = {
          bundleId,
          entries: [
            {
              relativePath: input.relativePath,
              bytes,
              sha256: createHash('sha256').update(input.content).digest('hex'),
            },
          ],
          totalBytes: bytes,
        }
        const complete = () => {
          saved.set(bundleId, { relativePath: input.relativePath, content: input.content })
          return result
        }
        entered.resolve()
        if (mode === 'sync') return complete()
        return ack.promise.then(() => {
          if (mode === 'failure') throw failure
          return complete()
        })
      }
    }
    const writer: EvidenceDocumentCommands = Object.freeze(new Writer())
    expect(Object.keys(writer)).toEqual([])
    const documents: EvidenceDocumentQueries = {
      readText(input) {
        expect(this).toBe(documents)
        const document = saved.get(input.bundleRef)
        return document?.relativePath === input.relativePath ? document.content : null
      },
    }
    const materializer = createRequirementMaterializer({
      bundleRefs: refs,
      store: fx.store,
      snapshots: fx.snapshots,
      evidence: fx.evidence,
      documents,
      documentCommands: writer,
      stagingRoot,
      now: Date.now,
    })
    const hold = async <T>(
      invoke: () => Promise<T>,
      purpose: 'direct-submission' | 'question-set' | 'answer-set',
    ) => {
      entered = Promise.withResolvers<void>()
      ack = Promise.withResolvers<void>()
      const beforeMission = await fx.store.getMission(missionId)
      const beforeRef = await refs.latest(missionId, purpose)
      let settled = false
      const pending = invoke().finally(() => {
        settled = true
      })
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('selected writer ACK missed')
          }),
        ])
        expect(settled).toBe(false)
        expect(await refs.latest(missionId, purpose)).toEqual(beforeRef)
        expect(await fx.store.getMission(missionId)).toEqual(beforeMission)
        expect(existsSync(stagingRoot)).toBe(false)
      } finally {
        ack.resolve()
      }
      return await pending
    }
    const submission = { title: 'Add feature', body: 'do the thing', uploads: [] }
    expect(
      await hold(
        () => materializer.stashDirectSubmission({ missionId, submission }),
        'direct-submission',
      ),
    ).toEqual({ ok: true, submissionRef: directSubmissionDigest(submission) })
    expect(calls[0]!.relativePath).toBe('submission.json')
    expect(calls[0]!.content).toBe(canonicalStringify(submission))
    const direct = await refs.latest(missionId, 'direct-submission')
    expect(direct?.evidenceRef).toBe('object:document:1')
    expect(direct?.totalBytes).toBe(new TextEncoder().encode(calls[0]!.content).byteLength)
    const count = calls.length
    await materializer.stashDirectSubmission({ missionId, submission })
    expect(calls).toHaveLength(count)
    const questions = await hold(
      () =>
        materializer.stashQuestionSet({
          missionId,
          origin: 'platform',
          channel: 'platform',
          questions: [{ questionId: 'q1', text: 'Which?', answerKind: 'text', choices: null }],
        }),
      'question-set',
    )
    if (!questions.ok) throw new Error('expected stored questions')
    expect(calls[1]!.relativePath).toBe('question-set.json')
    const questionRef = (await refs.get(questions.questionSetRef))!
    expect(questionRef.evidenceRef).toBe('object:document:2')
    expect(await materializer.loadQuestionSet(questions.questionSetRef)).toEqual(
      JSON.parse(calls[1]!.content),
    )
    const answers = [{ questionId: 'q1', answer: '中文' }]
    const result = await hold(
      () =>
        materializer.stashAnswerSet({
          missionId,
          questionSetRef: questions.questionSetRef,
          answers,
        }),
      'answer-set',
    )
    expect(result.ok).toBe(true)
    expect(calls[2]!.relativePath).toBe('answer-set.json')
    expect((await refs.latest(missionId, 'answer-set'))?.evidenceRef).toBe('object:document:3')
    mode = 'sync'
    const sync = await materializer.stashQuestionSet({
      missionId,
      origin: 'agent',
      channel: 'platform',
      questions: [{ questionId: 'q2', text: 'Again?', answerKind: 'text', choices: null }],
    })
    expect(sync.ok).toBe(true)
    const beforeFailure = await refs.latest(missionId, 'question-set')
    mode = 'failure'
    await expect(
      hold(
        () =>
          materializer.stashQuestionSet({
            missionId,
            origin: 'platform',
            channel: 'platform',
            questions: [{ questionId: 'q3', text: 'Failure?', answerKind: 'text', choices: null }],
          }),
        'question-set',
      ),
    ).rejects.toBe(failure)
    expect(await refs.latest(missionId, 'question-set')).toEqual(beforeFailure)
    expect(existsSync(stagingRoot)).toBe(false)
  }, 20_000)
})

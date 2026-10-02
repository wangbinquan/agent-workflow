// RFC-370 A2: submission replay, materialization and question/manifest queries
// must await the same selected logical document reader before touching rows.
import { afterEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import type { EvidenceDocumentQueries } from '@/modules/development-automation/application/evidenceDocuments'
import {
  createRequirementMaterializer,
  directSubmissionDigest,
} from '@/modules/development-automation/infrastructure/requirementMaterializer'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import type { RequirementBundleManifestV1 } from '@/modules/development-automation/domain/requirementManifest'
import type { QuestionSetV1 } from '@/modules/development-automation/domain/questionSet'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-370 selected requirement document reader', (harness) => {
  test('four materializer consumers await selected bytes, retain codecs and never read a local bundle', async () => {
    const fx = await buildPr3Fixture({ db: harness.db })
    roots.push(fx.stagingRoot, dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))))
    const missionId = await fx.launchDirect('selected-documents')
    const submission = { title: 'Add feature', body: 'do the thing', uploads: [] }
    const digest = directSubmissionDigest(submission)
    const question: QuestionSetV1 = {
      schemaVersion: 1,
      missionRef: missionId,
      origin: 'platform',
      channel: 'platform',
      questions: [{ questionId: 'q1', text: 'Which?', answerKind: 'text', choices: null }],
    }
    const manifest: RequirementBundleManifestV1 = {
      schemaVersion: 1,
      bundleId: 'object:bundle',
      source: { kind: 'direct', submissionId: digest },
      title: 'Selected manifest',
      fetchedAt: '2026-10-03T00:00:00+00:00',
      complete: true,
      files: [],
      totals: { files: 0, bytes: 0 },
      writebackRef: null,
      manifestDigest: 'c'.repeat(64),
    }
    const refs = createRequirementBundleRefPersistence(harness.db)
    for (const [id, purpose, evidenceRef, manifestDigest] of [
      ['direct', 'direct-submission', 'object:submission', digest],
      ['question', 'question-set', 'object:questions', 'b'.repeat(64)],
      ['manifest', 'requirement-manifest', 'object:manifest', manifest.manifestDigest],
    ] as const)
      await refs.insert({
        id,
        missionId,
        purpose,
        evidenceRef,
        manifestDigest,
        fileCount: 1,
        totalBytes: 0,
        retentionState: 'active',
        createdAt: Date.now(),
      })
    const values = new Map([
      ['object:submission', ['submission.json', JSON.stringify(submission)]],
      ['object:questions', ['question-set.json', JSON.stringify(question)]],
      ['object:manifest', ['requirement-manifest.json', JSON.stringify(manifest)]],
    ])
    let entered = Promise.withResolvers<void>(),
      ready = Promise.withResolvers<void>()
    let mode: 'content' | 'missing' | 'invalid' | 'schema' | 'failure' = 'content'
    const failure = new Error('selected document read unavailable')
    const documents: EvidenceDocumentQueries = {
      async readText(input) {
        expect(this).toBe(documents)
        const value = values.get(input.bundleRef)
        expect(value?.[0]).toBe(input.relativePath)
        entered.resolve()
        await ready.promise
        if (mode === 'failure') throw failure
        if (mode === 'missing') return null
        if (mode === 'invalid') return '{invalid'
        return mode === 'schema' ? '{}' : value![1]!
      },
    }
    const materializer = createRequirementMaterializer({
      bundleRefs: refs,
      store: fx.store,
      snapshots: fx.snapshots,
      evidence: fx.evidence,
      stagingRoot: fx.stagingRoot,
      documents,
      now: Date.now,
    })
    for (const invoke of [
      () => materializer.stashDirectSubmission({ missionId, submission }),
      () => materializer.loadQuestionSet('question'),
      () => materializer.getRequirementManifestMount(missionId, manifest.manifestDigest),
      () => materializer.materializeDirect({ missionId, submissionRef: digest }),
    ]) {
      entered = Promise.withResolvers<void>()
      ready = Promise.withResolvers<void>()
      const before = await fx.store.getMission(missionId)
      let settled = false
      const pending = invoke().finally(() => {
        settled = true
      })
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('selected document ACK missed')
          }),
        ])
        expect(settled).toBe(false)
        expect(await fx.store.getMission(missionId)).toEqual(before)
      } finally {
        ready.resolve()
      }
      const result = await pending
      expect(result).not.toBeNull()
      if (result !== null && 'ok' in result) expect(result.ok).toBe(true)
      else if (result !== null && 'questions' in result) expect(result).toEqual(question)
      else expect(result).toEqual({ bundleId: 'object:manifest', fileIds: [] })
    }
    mode = 'missing'
    expect(await materializer.loadQuestionSet('question')).toBeNull()
    mode = 'schema'
    expect(await materializer.loadQuestionSet('question')).toBeNull()
    mode = 'invalid'
    await expect(materializer.loadQuestionSet('question')).rejects.toBeInstanceOf(SyntaxError)
    mode = 'failure'
    await expect(materializer.loadQuestionSet('question')).rejects.toBe(failure)
    mode = 'content'
    expect(await materializer.getRequirementManifestMount(missionId, 'f'.repeat(64))).toBeNull()
  }, 20_000)
})

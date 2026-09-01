// RFC-310 PR-3 T33/T35/T38/T38a —— RequirementMaterializePort 的生产实现。
//
// 分工（design §5.2/§5.3）：外部程序只把文件落进 one-shot sink 并转述
// envelope 事实（integration 的 RequirementSourceExecution，经**结构同形**
// 依赖注入——本模块不得 import integration 内部，见 rfc294 preflight）；
// 平台侧在这里做全部可信工作：EvidenceStore safe-walk import（byte 事实以
// 我们重扫为准，adapter 自报不作数）、RequirementBundleManifestV1 生成与
// canonical digest、developmentBundleRefs 台账（purpose：requirement-bundle /
// requirement-manifest / direct-submission / question-set / answer-set）。
// 大字节永不过 DB；DB 行只有 ref + digest + 计数。
//
// direct 物化的数据可得性：launch 只落 digest（launchMission 不持正文），
// 正文必须先经 stashDirectSubmission 存为 evidence（路由装配在 launch 后
// 调用；stash 的 canonical digest 必须与 mission.sourceContentDigest 对上，
// 对不上 = contract-violation，杜绝「stash 什么就物化什么」的偷换）。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'
import type { OperationFailureReceipt } from '../domain/operationFailure'
import {
  requirementBundleManifestV1Schema,
  type RequirementBundleManifestV1,
} from '../domain/requirementManifest'
import {
  answerRevisionOf,
  answerSetV1Schema,
  correlateAnswers,
  questionSetV1Schema,
  type QuestionSetV1,
} from '../domain/questionSet'
import type { MissionPersistence } from '../application/ports/missionStore'
import type {
  RequirementBundleRefPersistence,
  RequirementBundleRefPurpose,
} from '../application/ports/requirementBundleRefStore'
import type {
  FactSnapshotReader,
  PortOutcome,
  RequirementMaterializePort,
} from '../application/ports/reconcilerPorts'
import type { EvidenceBudget, EvidenceStore } from './evidenceStore'

/** direct 提交 / 问答文档的平台预算（外部取件用 adapter 声明的 outputBudget）。 */
export const DIRECT_SUBMISSION_BUDGET: EvidenceBudget = {
  maxFiles: 128,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
}

/** 与 launchMission.directContentDigest 同形的内容寻址（结构性配对锁在测试）。 */
export interface DirectSubmissionDoc {
  readonly title: string
  readonly body: string | null
  readonly uploads: readonly {
    readonly ordinal: number
    readonly fileName: string
    readonly sha256: string | null
    readonly targetPath: string
    readonly collisionMode: string
    readonly contentPolicy: string
    readonly fileMode: string
  }[]
}

export function directSubmissionDigest(doc: DirectSubmissionDoc): string {
  return canonicalDigest({
    title: doc.title.trim(),
    body: doc.body?.trim() ?? null,
    uploads: doc.uploads.map((u) => ({
      ordinal: u.ordinal,
      fileName: u.fileName,
      sha256: u.sha256,
      targetPath: u.targetPath,
      collisionMode: u.collisionMode,
      contentPolicy: u.contentPolicy,
      fileMode: u.fileMode,
    })),
  })
}

/**
 * integration 的 RequirementSourceExecution 的结构同形窄依赖（本模块不
 * import provider 内部；装配点/测试把 createRequirementSourceAdapter 的
 * 返回值原样注入——两边形状由 rfc310-pr3-adapter-runner 测试配对锁定）。
 */
export interface RequirementSourceRunnerDep {
  acquire(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly sinkPath: string
  }): Promise<
    | {
        readonly ok: true
        readonly sourceRevision: string
        readonly title: string
        readonly files: readonly { readonly relativePath: string; readonly role: string }[]
        readonly outputBudget: EvidenceBudget
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  publishQuestions(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly questionsJson: string
    readonly sinkPath: string
  }): Promise<
    | { readonly ok: true; readonly correlationRef: string }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  collectAnswers(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly correlationRef: string
    readonly sinkPath: string
  }): Promise<
    | {
        readonly ok: true
        readonly complete: boolean
        readonly answerRevision: string | null
        readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
}

export interface RequirementMaterializerDeps {
  readonly bundleRefs: RequirementBundleRefPersistence
  readonly store: MissionPersistence
  readonly snapshots: FactSnapshotReader
  readonly evidence: EvidenceStore
  /** one-shot sink 的宿主根（每次操作一个 ulid 子目录，用完即删）。 */
  readonly stagingRoot: string
  readonly source?: RequirementSourceRunnerDep
  readonly now: () => number
}

export interface RequirementMaterializer extends RequirementMaterializePort {
  /** launch 后的路由装配步骤：把 direct 正文存为 evidence（digest 必须与 mission 一致）。 */
  stashDirectSubmission(input: {
    readonly missionId: string
    readonly submission: DirectSubmissionDoc
  }): Promise<PortOutcome<{ readonly submissionRef: string }>>
  /** 问题集入台账 + pending cells 落 requirement 快照（reconciler 下轮据此派 publish）。 */
  stashQuestionSet(input: {
    readonly missionId: string
    readonly origin: 'platform' | 'agent'
    readonly channel: 'platform' | 'requirement-source'
    readonly questions: QuestionSetV1['questions']
  }): Promise<PortOutcome<{ readonly questionSetRef: string }>>
  loadQuestionSet(questionSetRef: string): Promise<QuestionSetV1 | null>
  /** T35 台账读侧：mission 最新 requirement manifest（无则 null）。 */
  getRequirementManifest(missionId: string): Promise<RequirementBundleManifestV1 | null>
  /** T38 预览：重取外部源，与最新 generation 比对 sourceRevision；不落 mission 状态。 */
  previewExternalRefresh(missionId: string): Promise<
    PortOutcome<{
      readonly changed: boolean
      readonly currentSourceRevision: string | null
      readonly newSourceRevision: string
      readonly bundleRef: string
      readonly manifestDigest: string
      readonly fileCount: number
      readonly totalBytes: number
    }>
  >
  /** T38 应用：changed 时落新 generation source row + 重置 requirement cells。 */
  applyExternalRefresh(
    missionId: string,
  ): Promise<PortOutcome<{ readonly changed: boolean; readonly sourceRevision: string }>>
}

function fail(
  category: OperationFailureReceipt['category'],
  code: string,
  retryability: OperationFailureReceipt['retryability'],
  remediation: string,
): { ok: false; failure: OperationFailureReceipt } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

function mediaTypeOf(relativePath: string): string {
  if (relativePath.endsWith('.md')) return 'text/markdown'
  if (relativePath.endsWith('.txt')) return 'text/plain'
  if (relativePath.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

export function createRequirementMaterializer(
  deps: RequirementMaterializerDeps,
): RequirementMaterializer {
  const { bundleRefs, store, snapshots, evidence, stagingRoot } = deps
  mkdirSync(stagingRoot, { recursive: true })

  const insertBundleRef = async (input: {
    missionId: string
    purpose: RequirementBundleRefPurpose
    evidenceRef: string
    manifestDigest: string
    fileCount: number
    totalBytes: number
  }): Promise<string> => {
    const id = ulid()
    await bundleRefs.insert({
      id,
      missionId: input.missionId,
      purpose: input.purpose,
      evidenceRef: input.evidenceRef,
      manifestDigest: input.manifestDigest,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      retentionState: 'active',
      createdAt: deps.now(),
    })
    return id
  }

  const latestBundleRef = (missionId: string, purpose: RequirementBundleRefPurpose) =>
    bundleRefs.latest(missionId, purpose)

  const bundleRefById = (id: string) => bundleRefs.get(id)

  /** 单 JSON 文档 → evidence bundle（staged 一次性目录，导入即删）。 */
  const importJsonDoc = async (
    fileName: string,
    value: unknown,
  ): Promise<{ bundleId: string; totalBytes: number }> => {
    const dir = join(stagingRoot, ulid())
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(join(dir, fileName), canonicalStringify(value))
      const bundle = await evidence.importStagedTree(dir, DIRECT_SUBMISSION_BUDGET)
      return { bundleId: bundle.bundleId, totalBytes: bundle.totalBytes }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const readJsonDoc = (bundleId: string, fileName: string): unknown | null => {
    const bundle = evidence.getBundle(bundleId)
    const entry = bundle?.entries.find((e) => e.relativePath === fileName)
    if (bundle === null || bundle === undefined || entry === undefined) return null
    return JSON.parse(readFileSync(evidence.blobPath(entry.sha256), 'utf8')) as unknown
  }

  /** requirement cells 落新快照 + requirementBundleRef 指过去（OCC 冲突重试 3 次）。 */
  const persistCells = async (
    missionId: string,
    patch: Record<string, FactCell<FactCellValue>>,
    refs: unknown,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const mission = await store.getMission(missionId)
      if (mission === null) return false
      const base =
        mission.requirementBundleRef === null
          ? {}
          : ((await snapshots.getCells(mission.requirementBundleRef)) ?? {})
      const merged = { ...base, ...patch }
      const now = deps.now()
      const snapshotId = ulid()
      await store.insertFactSnapshot({
        id: snapshotId,
        missionId,
        missionRevision: mission.revision,
        capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(merged),
        refsJson: canonicalStringify(refs),
        digest: canonicalDigest(merged),
        now,
      })
      const result = await store.occUpdate(mission.id, mission.revision, mission.epoch, {
        requirementBundleRef: snapshotId,
      })
      if (result.ok) return true
      if (result.code === 'not-found') return false
    }
    return false
  }

  /**
   * 外部取件的共享内核：sink → adapter → safe import → 平台 manifest。
   * envelope 声明而 sink 里不存在的文件 = contract-violation（自报不作数的
   * 反向也成立：sink 里多出的文件照收，role 记 attachment）。
   */
  const acquireToBundle = async (input: {
    missionId: string
    adapterBindingRef: string
    externalId: string
  }): Promise<
    PortOutcome<{
      bundleRef: string
      manifestDigest: string
      fileCount: number
      totalBytes: number
      sourceRevision: string
      complete: boolean
    }>
  > => {
    if (deps.source === undefined) {
      return fail(
        'configuration',
        'requirement-source-not-wired',
        'after-configuration',
        'inject RequirementSourceRunnerDep at composition',
      )
    }
    const mission = await store.getMission(input.missionId)
    if (mission === null) {
      return fail('configuration', 'mission-not-found', 'never', 'mission row disappeared')
    }
    const sink = join(stagingRoot, ulid())
    mkdirSync(sink, { recursive: true })
    try {
      const acquired = await deps.source.acquire({
        adapterBindingRef: input.adapterBindingRef,
        externalId: input.externalId,
        sinkPath: sink,
      })
      if (!acquired.ok) return acquired
      let imported
      try {
        imported = await evidence.importStagedTree(sink, acquired.outputBudget)
      } catch (error) {
        return fail(
          'contract-violation',
          'staged-tree-rejected',
          'never',
          `safe import rejected the staged sink: ${String(error).slice(0, 160)}`,
        )
      }
      const byPath = new Map(imported.entries.map((entry) => [entry.relativePath, entry]))
      for (const declared of acquired.files) {
        if (!byPath.has(declared.relativePath)) {
          return fail(
            'contract-violation',
            'envelope-file-missing',
            'never',
            `adapter envelope declares '${declared.relativePath}' but the sink does not contain it`,
          )
        }
      }
      const roleByPath = new Map(acquired.files.map((f) => [f.relativePath, f.role]))
      const now = deps.now()
      const core = {
        schemaVersion: 1 as const,
        bundleId: imported.bundleId,
        source: {
          kind: 'external' as const,
          sourceKey: mission.resolvedSourceKey ?? input.adapterBindingRef,
          externalId: input.externalId,
          sourceRevision: acquired.sourceRevision,
        },
        title: acquired.title,
        fetchedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        complete: true,
        files: imported.entries.map((entry, ordinal) => ({
          fileId: entry.sha256,
          ordinal,
          relativePath: entry.relativePath,
          role: roleByPath.get(entry.relativePath) ?? 'attachment',
          mediaType: mediaTypeOf(entry.relativePath),
          bytes: entry.bytes,
          sha256: entry.sha256,
          redaction: 'none' as const,
          repositoryPlacement: null,
        })),
        totals: { files: imported.entries.length, bytes: imported.totalBytes },
        writebackRef: null,
      }
      const manifestDigest = canonicalDigest(core)
      const manifest = requirementBundleManifestV1Schema.parse({ ...core, manifestDigest })
      const manifestDoc = await importJsonDoc('requirement-manifest.json', manifest)
      await insertBundleRef({
        missionId: input.missionId,
        purpose: 'requirement-bundle',
        evidenceRef: imported.bundleId,
        manifestDigest,
        fileCount: imported.entries.length,
        totalBytes: imported.totalBytes,
      })
      await insertBundleRef({
        missionId: input.missionId,
        purpose: 'requirement-manifest',
        evidenceRef: manifestDoc.bundleId,
        manifestDigest,
        fileCount: 1,
        totalBytes: manifestDoc.totalBytes,
      })
      return {
        ok: true,
        bundleRef: imported.bundleId,
        manifestDigest,
        fileCount: imported.entries.length,
        totalBytes: imported.totalBytes,
        sourceRevision: acquired.sourceRevision,
        complete: true,
      }
    } finally {
      rmSync(sink, { recursive: true, force: true })
    }
  }

  const loadQuestionSet = async (questionSetRef: string): Promise<QuestionSetV1 | null> => {
    const row = await bundleRefById(questionSetRef)
    if (row === null || row.purpose !== 'question-set') return null
    const doc = readJsonDoc(row.evidenceRef, 'question-set.json')
    if (doc === null) return null
    const parsed = questionSetV1Schema.safeParse(doc)
    return parsed.success ? parsed.data : null
  }

  const stashAnswerSetDoc = async (input: {
    missionId: string
    questionSetRef: string
    channel: 'platform' | 'requirement-source'
    answerRevision: string
    answers: readonly { readonly questionId: string; readonly answer: string }[]
    complete: boolean
  }): Promise<string> => {
    const answerSet = answerSetV1Schema.parse({
      schemaVersion: 1,
      questionSetRef: input.questionSetRef,
      channel: input.channel,
      answerRevision: input.answerRevision,
      answers: [...input.answers],
      complete: input.complete,
    })
    const doc = await importJsonDoc('answer-set.json', answerSet)
    return await insertBundleRef({
      missionId: input.missionId,
      purpose: 'answer-set',
      evidenceRef: doc.bundleId,
      manifestDigest: canonicalDigest(answerSet),
      fileCount: 1,
      totalBytes: doc.totalBytes,
    })
  }

  return {
    // RFC-310 T81 —— reopen 的新 Mission 继承原 Mission 的需求证据。只复制
    // `development_bundle_refs` 的指针行：evidence blob 内容寻址，两条 Mission
    // 指向同一份，既不复制字节也不需要重新下载外部来源。
    async carryOverRequirementEvidence(input) {
      return await bundleRefs.copyLatestRequirements({
        fromMissionId: input.fromMissionId,
        toMissionId: input.toMissionId,
        copies: [
          { purpose: 'direct-submission', id: ulid() },
          { purpose: 'requirement-bundle', id: ulid() },
          { purpose: 'requirement-manifest', id: ulid() },
        ],
        createdAt: deps.now(),
      })
    },
    async stashDirectSubmission(input) {
      const mission = await store.getMission(input.missionId)
      if (mission === null) {
        return fail('configuration', 'mission-not-found', 'never', 'mission row disappeared')
      }
      if (mission.sourceKind !== 'direct') {
        return fail(
          'contract-violation',
          'direct-submission-kind-mismatch',
          'never',
          'cannot attach a direct submission to an external-reference mission',
        )
      }
      const digest = directSubmissionDigest(input.submission)
      if (mission.sourceContentDigest !== null && mission.sourceContentDigest !== digest) {
        return fail(
          'contract-violation',
          'direct-submission-digest-mismatch',
          'never',
          'stashed submission does not match the digest frozen at launch',
        )
      }
      const existing = await latestBundleRef(input.missionId, 'direct-submission')
      if (existing?.manifestDigest === digest) {
        const raw = readJsonDoc(existing.evidenceRef, 'submission.json')
        if (raw !== null && directSubmissionDigest(raw as DirectSubmissionDoc) === digest) {
          return { ok: true, submissionRef: digest }
        }
      }
      const doc = await importJsonDoc('submission.json', input.submission)
      await insertBundleRef({
        missionId: input.missionId,
        purpose: 'direct-submission',
        evidenceRef: doc.bundleId,
        manifestDigest: digest,
        fileCount: 1,
        totalBytes: doc.totalBytes,
      })
      return { ok: true, submissionRef: digest }
    },

    async materializeDirect(input) {
      const stash = await latestBundleRef(input.missionId, 'direct-submission')
      if (stash === null) {
        return fail(
          'configuration',
          'direct-submission-not-staged',
          'after-configuration',
          'call stashDirectSubmission after launch before materializing',
        )
      }
      if (stash.manifestDigest !== input.submissionRef) {
        return fail(
          'contract-violation',
          'direct-submission-digest-mismatch',
          'never',
          'stashed submission digest does not match the mission submissionRef',
        )
      }
      const raw = readJsonDoc(stash.evidenceRef, 'submission.json')
      if (raw === null) {
        return fail('configuration', 'direct-submission-unreadable', 'never', 'stash blob missing')
      }
      const submission = raw as DirectSubmissionDoc
      if (directSubmissionDigest(submission) !== input.submissionRef) {
        return fail(
          'contract-violation',
          'direct-submission-digest-mismatch',
          'never',
          'stash content drifted from its recorded digest',
        )
      }
      const dir = join(stagingRoot, ulid())
      mkdirSync(dir, { recursive: true })
      let imported
      try {
        if (submission.body !== null && submission.body.trim().length > 0) {
          writeFileSync(join(dir, 'body.md'), submission.body)
        }
        imported = await evidence.importStagedTree(dir, DIRECT_SUBMISSION_BUDGET)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      const now = deps.now()
      const core = {
        schemaVersion: 1 as const,
        bundleId: imported.bundleId,
        source: { kind: 'direct' as const, submissionId: stash.id },
        title: submission.title,
        fetchedAt: new Date(now).toISOString().replace('Z', '+00:00'),
        complete: true,
        files: imported.entries.map((entry, ordinal) => ({
          fileId: entry.sha256,
          ordinal,
          relativePath: entry.relativePath,
          role: 'body',
          mediaType: mediaTypeOf(entry.relativePath),
          bytes: entry.bytes,
          sha256: entry.sha256,
          redaction: 'none' as const,
          repositoryPlacement: null,
        })),
        totals: { files: imported.entries.length, bytes: imported.totalBytes },
        writebackRef: null,
      }
      const manifestDigest = canonicalDigest(core)
      const manifest = requirementBundleManifestV1Schema.parse({ ...core, manifestDigest })
      const manifestDoc = await importJsonDoc('requirement-manifest.json', manifest)
      await insertBundleRef({
        missionId: input.missionId,
        purpose: 'requirement-bundle',
        evidenceRef: imported.bundleId,
        manifestDigest,
        fileCount: imported.entries.length,
        totalBytes: imported.totalBytes,
      })
      await insertBundleRef({
        missionId: input.missionId,
        purpose: 'requirement-manifest',
        evidenceRef: manifestDoc.bundleId,
        manifestDigest,
        fileCount: 1,
        totalBytes: manifestDoc.totalBytes,
      })
      return {
        ok: true,
        bundleRef: imported.bundleId,
        manifestDigest,
        fileCount: imported.entries.length,
        totalBytes: imported.totalBytes,
        sourceRevision: input.submissionRef,
      }
    },

    async acquireExternal(input) {
      return acquireToBundle(input)
    },

    async publishQuestions(input) {
      const questionSet = await loadQuestionSet(input.questionSetRef)
      if (questionSet === null) {
        return fail(
          'configuration',
          'question-set-missing',
          'never',
          'question set stash not found',
        )
      }
      if (input.channel === 'platform') {
        // 平台渠道零外呼：correlation 就是问题集自身。
        return { ok: true, correlationRef: `platform:${input.questionSetRef}` }
      }
      if (deps.source === undefined || input.adapterBindingRef === null) {
        return fail(
          'configuration',
          'requirement-source-not-wired',
          'after-configuration',
          'requirement-source channel needs the adapter runner wired',
        )
      }
      const mission = await store.getMission(input.missionId)
      if (mission === null || mission.externalId === null) {
        return fail('configuration', 'external-id-missing', 'never', 'mission has no external id')
      }
      const sink = join(stagingRoot, ulid())
      mkdirSync(sink, { recursive: true })
      try {
        const published = await deps.source.publishQuestions({
          adapterBindingRef: input.adapterBindingRef,
          externalId: mission.externalId,
          questionsJson: canonicalStringify({
            questions: questionSet.questions.map((q) => ({
              questionId: q.questionId,
              text: q.text,
            })),
          }),
          sinkPath: sink,
        })
        if (!published.ok) return published
        return { ok: true, correlationRef: published.correlationRef }
      } finally {
        rmSync(sink, { recursive: true, force: true })
      }
    },

    async collectAnswers(input) {
      const questionSet = await loadQuestionSet(input.questionSetRef)
      if (questionSet === null) {
        return fail(
          'configuration',
          'question-set-missing',
          'never',
          'question set stash not found',
        )
      }
      if (deps.source === undefined) {
        return fail(
          'configuration',
          'requirement-source-not-wired',
          'after-configuration',
          'inject RequirementSourceRunnerDep at composition',
        )
      }
      const mission = await store.getMission(input.missionId)
      if (mission === null || mission.externalId === null) {
        return fail('configuration', 'external-id-missing', 'never', 'mission has no external id')
      }
      const sink = join(stagingRoot, ulid())
      mkdirSync(sink, { recursive: true })
      try {
        const collected = await deps.source.collectAnswers({
          adapterBindingRef: input.adapterBindingRef,
          externalId: mission.externalId,
          correlationRef: input.correlationRef,
          sinkPath: sink,
        })
        if (!collected.ok) return collected
        if (!collected.complete) {
          return { ok: true, complete: false, answerRevision: null, answerSetRef: null }
        }
        const correlation = correlateAnswers(questionSet, collected.answers)
        if (correlation.violations.length > 0 || !correlation.complete) {
          return fail(
            'contract-violation',
            'answer-correlation-violation',
            'never',
            `answers do not correlate with the question set: ${
              correlation.violations[0]?.code ?? 'incomplete'
            }`,
          )
        }
        const answerRevision = collected.answerRevision ?? answerRevisionOf(collected.answers)
        const answerSetRef = await stashAnswerSetDoc({
          missionId: input.missionId,
          questionSetRef: input.questionSetRef,
          channel: 'requirement-source',
          answerRevision,
          answers: collected.answers,
          complete: true,
        })
        return { ok: true, complete: true, answerRevision, answerSetRef }
      } finally {
        rmSync(sink, { recursive: true, force: true })
      }
    },

    async stashAnswerSet(input) {
      const questionSet = await loadQuestionSet(input.questionSetRef)
      if (questionSet === null) {
        return fail(
          'configuration',
          'question-set-missing',
          'never',
          'question set stash not found',
        )
      }
      const correlation = correlateAnswers(questionSet, input.answers)
      if (correlation.violations.length > 0) {
        return fail(
          'invalid-user-input',
          'answer-correlation-violation',
          'never',
          `answers do not correlate: ${correlation.violations[0]!.code} (${correlation.violations[0]!.questionId})`,
        )
      }
      if (!correlation.complete) {
        return fail(
          'invalid-user-input',
          'answers-incomplete',
          'never',
          'platform submission must answer every question',
        )
      }
      const answerRevision = answerRevisionOf(input.answers)
      const answerSetRef = await stashAnswerSetDoc({
        missionId: input.missionId,
        questionSetRef: input.questionSetRef,
        channel: 'platform',
        answerRevision,
        answers: input.answers,
        complete: true,
      })
      return { ok: true, answerSetRef, answerRevision }
    },

    async stashQuestionSet(input) {
      const questionSet = questionSetV1Schema.parse({
        schemaVersion: 1,
        missionRef: input.missionId,
        origin: input.origin,
        channel: input.channel,
        questions: [...input.questions],
      })
      const doc = await importJsonDoc('question-set.json', questionSet)
      const questionSetRef = await insertBundleRef({
        missionId: input.missionId,
        purpose: 'question-set',
        evidenceRef: doc.bundleId,
        manifestDigest: canonicalDigest(questionSet),
        fileCount: 1,
        totalBytes: doc.totalBytes,
      })
      const persisted = await persistCells(
        input.missionId,
        {
          '__requirement.pendingQuestionSetRef': {
            state: 'known',
            value: questionSetRef,
            sourceRevision: 'stash',
          },
          '__requirement.questionChannel': {
            state: 'known',
            value: input.channel,
            sourceRevision: 'stash',
          },
        },
        { kind: 'question-set-stash', questionSetRef },
      )
      if (!persisted) {
        return fail('transient', 'question-set-cells-conflict', 'same-input', 'occ retry exhausted')
      }
      return { ok: true, questionSetRef }
    },

    loadQuestionSet,

    async getRequirementManifest(missionId) {
      const row = await latestBundleRef(missionId, 'requirement-manifest')
      if (row === null) return null
      const doc = readJsonDoc(row.evidenceRef, 'requirement-manifest.json')
      if (doc === null) return null
      const parsed = requirementBundleManifestV1Schema.safeParse(doc)
      return parsed.success ? parsed.data : null
    },

    async getRequirementManifestMount(missionId, manifestDigest) {
      const row = await bundleRefs.findManifest(missionId, manifestDigest)
      if (row === null) return null
      const doc = readJsonDoc(row.evidenceRef, 'requirement-manifest.json')
      if (doc === null) return null
      const parsed = requirementBundleManifestV1Schema.safeParse(doc)
      if (!parsed.success || parsed.data.manifestDigest !== manifestDigest) return null
      return {
        bundleId: row.evidenceRef,
        fileIds: parsed.data.files.map((file) => file.fileId),
      }
    },

    async previewExternalRefresh(missionId) {
      const mission = await store.getMission(missionId)
      if (mission === null) {
        return fail('configuration', 'mission-not-found', 'never', 'mission row disappeared')
      }
      if (mission.sourceKind !== 'external-reference' || mission.externalId === null) {
        return fail('invalid-user-input', 'not-external-source', 'never', 'mission is not external')
      }
      if (mission.resolvedAdapterId === null || mission.resolvedAdapterRevision === null) {
        return fail(
          'configuration',
          'requirement-adapter-unresolved',
          'after-configuration',
          'resolve the requirement source before refreshing',
        )
      }
      const acquired = await acquireToBundle({
        missionId,
        adapterBindingRef: `${mission.resolvedAdapterId}@${mission.resolvedAdapterRevision}`,
        externalId: mission.externalId,
      })
      if (!acquired.ok) return acquired
      const sources = await store.listMissionSources(missionId)
      const current = sources
        .filter((s) => s.sourceRevision !== null)
        .sort((a, b) => b.generation - a.generation)[0]
      const currentSourceRevision = current?.sourceRevision ?? null
      return {
        ok: true,
        changed: currentSourceRevision !== acquired.sourceRevision,
        currentSourceRevision,
        newSourceRevision: acquired.sourceRevision,
        bundleRef: acquired.bundleRef,
        manifestDigest: acquired.manifestDigest,
        fileCount: acquired.fileCount,
        totalBytes: acquired.totalBytes,
      }
    },

    async applyExternalRefresh(missionId) {
      const preview = await this.previewExternalRefresh(missionId)
      if (!preview.ok) return preview
      if (!preview.changed)
        return { ok: true, changed: false, sourceRevision: preview.newSourceRevision }
      const mission = await store.getMission(missionId)
      if (mission === null) {
        return fail('configuration', 'mission-not-found', 'never', 'mission row disappeared')
      }
      await store.insertMissionSource({
        id: ulid(),
        missionId,
        generation: (await store.listMissionSources(missionId)).length + 1,
        sourceKind: 'external-reference',
        externalId: mission.externalId,
        adapterId: mission.resolvedAdapterId,
        adapterRevision: mission.resolvedAdapterRevision,
        sourceRevision: preview.newSourceRevision,
        bundleRef: preview.bundleRef,
        manifestDigest: preview.manifestDigest,
        fileCount: preview.fileCount,
        totalBytes: preview.totalBytes,
        state: 'materialized',
        createdAt: deps.now(),
      })
      // 新 revision ⇒ 下游认知失效：bundleComplete 重置为 true（新 bundle），
      // 澄清状态清零（旧问答对旧 revision 成立）。invalidation 的动作/候选
      // 半边随 PR-5 T55 接入 action ledger。
      await persistCells(
        missionId,
        {
          'requirement.bundleComplete': { state: 'known', value: true, sourceRevision: 'refresh' },
          'requirement.clarificationState': {
            state: 'known',
            value: 'none',
            sourceRevision: 'refresh',
          },
        },
        {
          kind: 'requirement-refresh',
          bundleRef: preview.bundleRef,
          manifestDigest: preview.manifestDigest,
          sourceRevision: preview.newSourceRevision,
        },
      )
      return { ok: true, changed: true, sourceRevision: preview.newSourceRevision }
    },
  }
}

// RFC-310 PR-2 T31 / PR-3 收口 —— DevelopmentMission 的 HTTP 面。
//
// PR-2：launch/list/get/requirement-source/cancel/retry/decision-trace 七端点。
// PR-3：装配 composeDevelopmentAutomation（evidence/materializer/reconciler）——
// direct 正文在 launch 成功后由本层 stash 为 evidence（失败即补偿 cancel，
// 不留「已创建但正文丢失」的半吊子 mission）；mutation 成功后 fire-and-forget
// 一轮 reconcile（进度保证仍由 daemon 的 30s wake sweep 兜底，这里只降延迟）；
// 新增 requirement manifest / 逐文件 ranged 读 / answers / source-refresh
// preview·apply 端点。handoff/attach/resume/upgrade 与其 permission 点随
// PR-7/PR-8 挂载。mutation 都返回可追踪对象（missionId+status），不返回裸
// 「已接受」。
//
// UI/API 无 host path：manifest 与文件读全部经 opaque ref（bundleId/sha256），
// 文件字节从 EvidenceStore blob 流式出，不暴露 evidence 根路径。

import type { Hono } from 'hono'
import { z } from 'zod'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import {
  cancelMission,
  launchMission,
  launchMissionInputSchema,
  previewDirectInput,
  retryBlockedMission,
  selectMissionRequirementSource,
  type LaunchDeps,
} from '@/modules/development-automation/application/commands/launchMission'
import { submitMissionAnswers } from '@/modules/development-automation/application/commands/submitMissionAnswers'
import { composeDevelopmentAutomation } from '@/modules/development-automation/composition'
import { createRepositoryBaselineResolver } from '@/modules/development-automation/infrastructure/gitBaselineReader'
import { createSqliteAdmissionLookup } from '@/modules/development-automation/infrastructure/sqliteAdmissionLookup'
import { createSqliteFactSnapshotReader } from '@/modules/development-automation/infrastructure/sqliteReconcilerReaders'
import { createSqliteUploadSessionStore } from '@/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import { insertUploadPlan } from '@/modules/development-automation/infrastructure/sqliteUploadPlanStore'
import {
  getDecisionTrace,
  getMissionDetail,
  listMissionSummaries,
} from '@/modules/development-automation/infrastructure/missionReadModels'
import { createSqliteMissionStore } from '@/modules/development-automation/infrastructure/sqliteMissionStore'
import type { OperationFailureReceipt } from '@/modules/development-automation/domain/operationFailure'
import { composeRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import type { AppDeps } from '@/server'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('development-missions')

/** materializer PortOutcome 失败 → HTTP 错误（refresh preview/apply 共用）。 */
function refreshFailureError(failure: OperationFailureReceipt): DomainError {
  if (failure.code === 'mission-not-found') {
    return new NotFoundError('mission-not-found', 'mission not found')
  }
  if (failure.category === 'invalid-user-input') {
    return new ValidationError(failure.code, failure.remediation)
  }
  return new ConflictError(failure.code, failure.remediation)
}

export function mountDevelopmentMissionRoutes(app: Hono, deps: AppDeps): void {
  const uploadSessions = createSqliteUploadSessionStore(deps.db)
  const snapshots = createSqliteFactSnapshotReader(deps.db)
  const automation = composeDevelopmentAutomation({
    db: deps.db,
    appHome: Paths.root,
    requirementSource: composeRequirementSourceRunner(deps.db),
  })
  const launchDeps: LaunchDeps = {
    store: createSqliteMissionStore(deps.db),
    lookup: createSqliteAdmissionLookup(deps.db),
    now: () => Date.now(),
    uploadAdmission: {
      sessions: uploadSessions,
      transact: (fn) => deps.db.transaction(() => fn()),
      resolveBaseline: createRepositoryBaselineResolver(deps.db),
      persistPlan: (plan) => insertUploadPlan(deps.db, plan),
    },
  }

  const fireReconcile = (missionId: string): void => {
    void automation.reconcile(missionId).catch((err: unknown) => {
      log.warn('mission reconcile after route mutation failed', {
        missionId,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * launch 成功后的装配步骤（requirementMaterializer 契约）：direct 正文/上传
   * 语义按 mission 冻结的 digest stash 为 evidence。stash 失败 = mission 无法
   * 继续（materialize 永远差正文）——补偿 cancel 后对外报错，不返回 201。
   */
  const stashDirectAfterLaunch = async (raw: unknown, missionId: string): Promise<void> => {
    const parsed = launchMissionInputSchema.safeParse(raw)
    if (!parsed.success || parsed.data.submission.kind !== 'direct') return
    const submission = parsed.data.submission
    const stashed = await automation.materializer.stashDirectSubmission({
      missionId,
      submission: {
        title: submission.title,
        body: submission.body,
        uploads: submission.uploads.map((upload, ordinal) => {
          const row = uploadSessions.getUpload(upload.uploadRef)
          return {
            ordinal,
            fileName: row?.originalName ?? '',
            sha256: row?.sha256 ?? null,
            targetPath: upload.repositoryTargetPath,
            collisionMode: upload.collisionMode ?? 'create-only',
            contentPolicy: upload.contentPolicy ?? 'preserve-upload',
            fileMode: upload.fileMode ?? 'regular',
          }
        }),
      },
    })
    if (!stashed.ok) {
      try {
        await cancelMission(launchDeps, { missionId })
      } catch (err) {
        log.warn('stash compensation cancel failed', {
          missionId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      // 失败码透传（digest-mismatch 等由 materializer 测试点名；HTTP 面上这些
      // 分支在单请求内不可构造——stash 与 launch 同一 handler、无外部竞态窗口）。
      throw new ConflictError(
        stashed.failure.code,
        `direct submission stash failed: ${stashed.failure.remediation}`,
      )
    }
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Launch a development mission (direct body/uploads or external id)',
    },
    async (c) => {
      const actor = actorOf(c)
      const body = z.record(z.unknown()).parse(await safeJsonOrEmpty(c.req.raw))
      // actorUserId 永远 server-authoritative——覆盖 body 里的任何自报值。
      const input = { ...body, actorUserId: actor.user.id }
      const result = await launchMission(launchDeps, input)
      if (result.created) {
        await stashDirectAfterLaunch(input, result.missionId)
        fireReconcile(result.missionId)
      }
      return c.json(result, result.created ? 201 : 200)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/direct-input/preview',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Preview per-upload target dispositions against the current repository baseline',
    },
    async (c) => {
      const actor = actorOf(c)
      const body = z.record(z.unknown()).parse(await safeJsonOrEmpty(c.req.raw))
      const result = await previewDirectInput(launchDeps, { ...body, actorUserId: actor.user.id })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'List development missions',
    },
    async (c) => c.json({ items: listMissionSummaries(deps.db) }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Read one development mission (sources, readiness, block detail)',
    },
    async (c) => {
      const detail = getMissionDetail(deps.db, c.req.param('id'))
      if (detail === null) throw new NotFoundError('mission-not-found', 'mission not found')
      return c.json(detail)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id/requirement-manifest',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Read the immutable requirement bundle manifest for a mission',
    },
    async (c) => {
      const missionId = c.req.param('id')
      if (getMissionDetail(deps.db, missionId) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      const manifest = automation.materializer.getRequirementManifest(missionId)
      if (manifest === null) {
        throw new NotFoundError(
          'requirement-manifest-not-found',
          'no requirement bundle has been materialized for this mission yet',
        )
      }
      return c.json({ missionId, manifest })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id/requirement-files/:sha256',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Stream one requirement bundle file by content hash (supports Range)',
    },
    async (c) => {
      const missionId = c.req.param('id')
      if (getMissionDetail(deps.db, missionId) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      const manifest = automation.materializer.getRequirementManifest(missionId)
      if (manifest === null) {
        throw new NotFoundError(
          'requirement-manifest-not-found',
          'no requirement bundle has been materialized for this mission yet',
        )
      }
      // 只许读本 mission manifest 点名的内容 hash——blob 池是全局去重的，
      // 不做这层归属检查就等于任意 mission 可探全池。
      const sha256 = c.req.param('sha256')
      const entry = manifest.files.find((file) => file.sha256 === sha256)
      if (entry === undefined) {
        throw new NotFoundError(
          'requirement-file-not-found',
          'the hash is not part of this mission requirement bundle',
        )
      }
      const blob = Bun.file(automation.evidence.blobPath(sha256))
      if (!(await blob.exists())) {
        throw new NotFoundError('evidence-blob-missing', 'evidence blob is missing on disk')
      }
      const size = entry.bytes
      const baseHeaders = { 'content-type': entry.mediaType, 'accept-ranges': 'bytes' }
      const rangeHeader = c.req.header('range')
      if (rangeHeader === undefined) {
        return c.body(blob.stream(), 200, {
          ...baseHeaders,
          'content-length': String(size),
        })
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (match === null || (match[1] === '' && match[2] === '')) {
        throw new DomainError('range-not-satisfiable', 'unsupported Range header', 416, { size })
      }
      let start: number
      let end: number
      if (match[1] === '') {
        const suffix = Number(match[2])
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? size - 1 : Number(match[2])
      }
      if (start >= size || start > end) {
        throw new DomainError('range-not-satisfiable', `range out of bounds`, 416, { size })
      }
      end = Math.min(end, size - 1)
      return c.body(blob.slice(start, end + 1).stream(), 206, {
        ...baseHeaders,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/requirement-source',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Resolve the requirement source for a mission awaiting selection',
    },
    async (c) => {
      const body = z
        .object({ sourceKey: z.string().min(1) })
        .strict()
        .parse(await safeJsonOrEmpty(c.req.raw))
      const result = await selectMissionRequirementSource(launchDeps, {
        missionId: c.req.param('id'),
        sourceKey: body.sourceKey,
      })
      fireReconcile(c.req.param('id'))
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/answers',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Submit platform-channel answers for the pending question set',
    },
    async (c) => {
      const missionId = c.req.param('id')
      const body = z.record(z.unknown()).parse(await safeJsonOrEmpty(c.req.raw))
      const result = await submitMissionAnswers(
        {
          store: launchDeps.store,
          snapshots,
          requirement: automation.materializer,
          now: launchDeps.now,
        },
        { ...body, missionId },
      )
      fireReconcile(missionId)
      return c.json({ missionId, ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/source-refresh/preview',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary:
        'Re-fetch the external requirement source and compare source revisions (no state change)',
    },
    async (c) => {
      const missionId = c.req.param('id')
      if (getMissionDetail(deps.db, missionId) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      const out = await automation.materializer.previewExternalRefresh(missionId)
      if (!out.ok) throw refreshFailureError(out.failure)
      return c.json({
        missionId,
        changed: out.changed,
        currentSourceRevision: out.currentSourceRevision,
        newSourceRevision: out.newSourceRevision,
        manifestDigest: out.manifestDigest,
        fileCount: out.fileCount,
        totalBytes: out.totalBytes,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/source-refresh',
      permissions: ['development-missions:interact'],
      tokenAccess: 'allow',
      summary: 'Apply an external requirement source refresh (new source generation + cell reset)',
    },
    async (c) => {
      const missionId = c.req.param('id')
      if (getMissionDetail(deps.db, missionId) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      const out = await automation.materializer.applyExternalRefresh(missionId)
      if (!out.ok) throw refreshFailureError(out.failure)
      fireReconcile(missionId)
      return c.json({ missionId, changed: out.changed, sourceRevision: out.sourceRevision })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/cancel',
      permissions: ['development-missions:cancel'],
      tokenAccess: 'allow',
      summary: 'Cancel a mission (fences writes; settles dispatched effects first)',
    },
    async (c) => {
      const result = await cancelMission(launchDeps, { missionId: c.req.param('id') })
      fireReconcile(c.req.param('id'))
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/missions/:id/retry',
      permissions: ['development-missions:retry'],
      tokenAccess: 'allow',
      summary: 'Retry a blocked mission after remediation',
    },
    async (c) => {
      const result = await retryBlockedMission(launchDeps, { missionId: c.req.param('id') })
      fireReconcile(c.req.param('id'))
      return c.json({ missionId: c.req.param('id'), ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/missions/:id/decision-trace',
      permissions: ['development-missions:read'],
      tokenAccess: 'allow',
      summary: 'Read the canonical guard/rule decision trace for a mission',
    },
    async (c) => {
      if (getMissionDetail(deps.db, c.req.param('id')) === null) {
        throw new NotFoundError('mission-not-found', 'mission not found')
      }
      return c.json({ items: getDecisionTrace(deps.db, c.req.param('id')) })
    },
  )
}

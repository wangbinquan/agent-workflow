// RFC-310 PR-3 T36 —— mission 输入上传的 HTTP 面（design §12.1）。
//
// 单文件 bounded 接收：body 写临时文件 → EvidenceStore putBlobFromFile（流式
// hash + 内容寻址去重）→ 会话行。originalName 只作 UI 提示（header 提供），
// 永不自动成为仓库目标路径。上限 32MB（超限 413 typed）；TTL 到期由
// sweepExpired 回收。两端点沿用 `development-missions:launch`（§12.3）。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { createSqliteUploadSessionStore } from '@/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import type { AppDeps } from '@/server'
import { Paths } from '@/util/paths'
import { ValidationError } from '@/util/errors'

export const MISSION_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

export function mountMissionInputUploadRoutes(app: Hono, deps: AppDeps): void {
  const store = createSqliteUploadSessionStore(deps.db)
  const evidence = new EvidenceStore(join(Paths.root, 'evidence'))

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/mission-input-uploads',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Upload one temporary input file for a future mission launch',
    },
    async (c) => {
      const actor = actorOf(c)
      const originalName = (c.req.header('x-upload-name') ?? 'upload.bin').slice(0, 255)
      const idempotencyKey = c.req.header('x-upload-idempotency-key') ?? null
      const declared = Number(c.req.header('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MISSION_UPLOAD_MAX_BYTES) {
        throw new ValidationError('upload-too-large', 'upload exceeds the 32MB limit')
      }
      const bytes = new Uint8Array(await c.req.raw.arrayBuffer())
      if (bytes.byteLength === 0) {
        throw new ValidationError('upload-empty', 'upload body is empty')
      }
      if (bytes.byteLength > MISSION_UPLOAD_MAX_BYTES) {
        throw new ValidationError('upload-too-large', 'upload exceeds the 32MB limit')
      }
      const staging = mkdtempSync(join(tmpdir(), 'aw-upload-'))
      try {
        const tmpFile = join(staging, 'payload')
        writeFileSync(tmpFile, bytes)
        const blob = await evidence.putBlobFromFile(tmpFile)
        const row = store.createUpload({
          actorUserId: actor.user.id,
          originalName,
          bytes: blob.bytes,
          sha256: blob.sha256,
          blobRef: blob.sha256,
          idempotencyKey,
          now: Date.now(),
        })
        return c.json(
          {
            uploadRef: row.id,
            originalName: row.originalName,
            bytes: row.bytes,
            sha256: row.sha256,
            expiresAt: row.expiresAt,
          },
          201,
        )
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/code/mission-input-uploads/:uploadRef',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Discard an unclaimed temporary upload owned by the caller',
    },
    async (c) => {
      store.deleteUpload(c.req.param('uploadRef'), actorOf(c).user.id)
      return c.json({ ok: true })
    },
  )
}

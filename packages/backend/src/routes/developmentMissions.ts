// RFC-310/RFC-344 — HTTP bindings for DevelopmentMission operation descriptors.

import type { Hono } from 'hono'
import { z } from 'zod'
import { actorOf } from '@/auth/actor'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import {
  createDevelopmentMissionDescriptors,
  type DevelopmentMissionOperations,
} from '@/modules/development-automation/public/operations'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { DomainError } from '@/util/errors'
import { safeJsonOrEmpty, safeJsonOrThrowInvalid } from '@/util/http'

const recordBody = async (request: Request): Promise<Record<string, unknown>> =>
  z.record(z.unknown()).parse(await safeJsonOrEmpty(request))

export function mountDevelopmentMissionRoutes(
  app: Hono,
  operations: DevelopmentMissionOperations,
  contexts: DirectAuthorityBinding,
): void {
  const descriptor = createDevelopmentMissionDescriptors(operations)
  const context = (c: Parameters<typeof actorOf>[0]) =>
    directOperationAuthority(contexts, actorOf(c))

  registerOperationRoute(app, {
    descriptor: descriptor.launch,
    method: 'POST',
    path: '/api/code/missions',
    tokenAccess: 'allow',
    decode: async (c) => ({ body: await recordBody(c.req.raw) }),
    context,
    encode: (c, output) => c.json(output.body, output.created ? 201 : 200),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.preview,
    method: 'POST',
    path: '/api/code/missions/preview',
    tokenAccess: 'allow',
    decode: async (c) => ({ body: await recordBody(c.req.raw) }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.previewDirectInput,
    method: 'POST',
    path: '/api/code/missions/direct-input/preview',
    tokenAccess: 'allow',
    decode: async (c) => ({ body: await recordBody(c.req.raw) }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.list,
    method: 'GET',
    path: '/api/code/missions',
    tokenAccess: 'allow',
    decode: (c) => ({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      view: c.req.query('view'),
      statuses: c.req.query('statuses'),
      q: c.req.query('q'),
      employeeId: c.req.query('employeeId'),
      missionStatuses: c.req.query('missionStatuses'),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.listOutcomeSummaries,
    method: 'GET',
    path: '/api/code/missions/outcome-summaries',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json({ items: output }),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.get,
    method: 'GET',
    path: '/api/code/missions/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.getRequirementManifest,
    method: 'GET',
    path: '/api/code/missions/:id/requirement-manifest',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.getRequirementFile,
    method: 'GET',
    path: '/api/code/missions/:id/requirement-files/:sha256',
    tokenAccess: 'allow',
    decode: (c) => ({
      missionId: c.req.param('id'),
      sha256: c.req.param('sha256'),
    }),
    context,
    encode: (c, file) => {
      const baseHeaders = { 'content-type': file.mediaType, 'accept-ranges': 'bytes' }
      const rangeHeader = c.req.header('range')
      if (rangeHeader === undefined) {
        return c.body(file.openAll(), 200, {
          ...baseHeaders,
          'content-length': String(file.bytes),
        })
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (match === null || (match[1] === '' && match[2] === '')) {
        throw new DomainError('range-not-satisfiable', 'unsupported Range header', 416, {
          size: file.bytes,
        })
      }
      let start: number
      let end: number
      if (match[1] === '') {
        start = Math.max(0, file.bytes - Number(match[2]))
        end = file.bytes - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? file.bytes - 1 : Number(match[2])
      }
      if (start >= file.bytes || start > end) {
        throw new DomainError('range-not-satisfiable', 'range out of bounds', 416, {
          size: file.bytes,
        })
      }
      end = Math.min(end, file.bytes - 1)
      return c.body(file.open(start, end), 206, {
        ...baseHeaders,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${file.bytes}`,
      })
    },
  })
  registerOperationRoute(app, {
    descriptor: descriptor.selectRequirementSource,
    method: 'POST',
    path: '/api/code/missions/:id/requirement-source',
    tokenAccess: 'allow',
    decode: async (c) => ({
      missionId: c.req.param('id'),
      ...z
        .object({ sourceKey: z.string().min(1) })
        .strict()
        .parse(await safeJsonOrEmpty(c.req.raw)),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.submitAnswers,
    method: 'POST',
    path: '/api/code/missions/:id/answers',
    tokenAccess: 'allow',
    decode: async (c) => ({
      missionId: c.req.param('id'),
      body: await recordBody(c.req.raw),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.confirmNoChange,
    method: 'POST',
    path: '/api/code/missions/:id/confirm-no-change',
    tokenAccess: 'allow',
    decode: async (c) => ({
      missionId: c.req.param('id'),
      body: await recordBody(c.req.raw),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.previewSourceRefresh,
    method: 'POST',
    path: '/api/code/missions/:id/source-refresh/preview',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.applySourceRefresh,
    method: 'POST',
    path: '/api/code/missions/:id/source-refresh',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.cancel,
    method: 'POST',
    path: '/api/code/missions/:id/cancel',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.retry,
    method: 'POST',
    path: '/api/code/missions/:id/retry',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.decisionTrace,
    method: 'GET',
    path: '/api/code/missions/:id/decision-trace',
    tokenAccess: 'allow',
    decode: (c) => ({ missionId: c.req.param('id') }),
    context,
    encode: (c, output) => c.json({ items: output }),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.readPipelineEvidence,
    method: 'GET',
    path: '/api/code/missions/:id/pipeline-evidence/:sha256',
    tokenAccess: 'allow',
    decode: (c) => ({
      missionId: c.req.param('id'),
      sha256: c.req.param('sha256'),
      offset: Number(c.req.query('offset') ?? '0'),
      limit: Number(c.req.query('limit') ?? String(operations.maxPipelineEvidenceReadBytes)),
    }),
    context,
    encode: (c, read) =>
      c.body(Uint8Array.from(read.bytes), 200, {
        'content-type': read.mediaType,
        'content-length': String(read.bytes.byteLength),
        'x-evidence-total-bytes': String(read.totalBytes),
        'x-evidence-truncated': read.truncated ? 'true' : 'false',
        ...(read.nextOffset === null ? {} : { 'x-evidence-next-offset': String(read.nextOffset) }),
      }),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.handoff,
    method: 'POST',
    path: '/api/code/missions/:id/handoff',
    tokenAccess: 'allow',
    decode: async (c) => ({
      missionId: c.req.param('id'),
      body: await recordBody(c.req.raw),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.attachMergeRequest,
    method: 'POST',
    path: '/api/code/missions/:id/attach-mr',
    tokenAccess: 'allow',
    decode: async (c) => ({
      missionId: c.req.param('id'),
      body: await recordBody(c.req.raw),
    }),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.resume,
    method: 'POST',
    path: '/api/code/missions/:id/resume',
    tokenAccess: 'allow',
    decode: async (c) => {
      await recordBody(c.req.raw)
      return { missionId: c.req.param('id') }
    },
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.readCutover,
    method: 'GET',
    path: '/api/code/cutover',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.materializeCutover,
    method: 'POST',
    path: '/api/code/cutover/materialize',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.freezeCutover,
    method: 'POST',
    path: '/api/code/cutover/freeze',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.flipCutover,
    method: 'POST',
    path: '/api/code/cutover/flip',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.rollbackCutover,
    method: 'POST',
    path: '/api/code/cutover/rollback',
    tokenAccess: 'allow',
    decode: () => ({}),
    context,
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: descriptor.adoptMergeRequest,
    method: 'POST',
    path: '/api/code/cutover/adopt-mr',
    tokenAccess: 'allow',
    decode: async (c) => ({ body: await safeJsonOrThrowInvalid(c.req.raw) }),
    context,
    encode: (c, output) => c.json(output),
  })
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { z } from 'zod'

import { actorOf } from '@/auth/actor'
import type { DigitalEmployeeModule } from '@/modules/digital-employee/composition'
import { registerRoute } from '@/routes/registry'
import { ForbiddenError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'
import { jsonDocumentResponse } from '@/util/jsonDocument'

function parseEmployeeTypeRef(value: string): {
  readonly typeId: string
  readonly revision: number
} {
  const at = value.lastIndexOf('@')
  const revision = Number(value.slice(at + 1))
  if (at <= 0 || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new ValidationError(
      'employee-type-ref-invalid',
      'employee type ref must use <typeId>@<revision>',
    )
  }
  return { typeId: value.slice(0, at), revision }
}

function actorId(c: Parameters<typeof actorOf>[0]): string | null {
  return actorOf(c).user.id
}

function actorForToolAuthoring(c: Parameters<typeof actorOf>[0], body: unknown) {
  const toolKind = z
    .object({ implementation: z.object({ kind: z.string() }).passthrough() })
    .passthrough()
    .parse(body).implementation.kind
  const actor = actorOf(c)
  if (toolKind === 'program' && !actor.permissions.has('scripts:author')) {
    throw new ForbiddenError(
      'scripts-author-required',
      'authoring a ProgramTool requires scripts:author',
    )
  }
  return actor
}

export function mountDigitalEmployeeRoutes(app: Hono, module: DigitalEmployeeModule): void {
  const maxUploadBytes = 32 * 1024 * 1024

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-input-uploads',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Upload one temporary file that a digital employee must commit at an exact path',
    },
    async (c) => {
      const declared = Number(c.req.header('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxUploadBytes) {
        throw new ValidationError('employee-upload-too-large', 'upload exceeds the 32MB limit')
      }
      const bytes = new Uint8Array(await c.req.raw.arrayBuffer())
      if (bytes.byteLength === 0) {
        throw new ValidationError('employee-upload-empty', 'upload body is empty')
      }
      if (bytes.byteLength > maxUploadBytes) {
        throw new ValidationError('employee-upload-too-large', 'upload exceeds the 32MB limit')
      }
      const directory = mkdtempSync(join(tmpdir(), 'aw-employee-upload-'))
      try {
        const path = join(directory, 'payload')
        writeFileSync(path, bytes)
        const upload = await module.inputUploads.create({
          absolutePath: path,
          originalName: (c.req.header('x-upload-name') ?? 'upload.bin').slice(0, 255),
          actorUserId: actorId(c),
          idempotencyKey: c.req.header('x-upload-idempotency-key') ?? null,
        })
        return c.json(
          {
            uploadRef: upload.id,
            originalName: upload.originalName,
            bytes: upload.bytes,
            sha256: upload.sha256,
            expiresAt: upload.expiresAt,
          },
          201,
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/digital-employee-input-uploads/:uploadRef',
      permissions: ['development-missions:launch'],
      tokenAccess: 'allow',
      summary: 'Discard one unclaimed digital employee input upload',
    },
    (c) => {
      module.inputUploads.delete(c.req.param('uploadRef'), actorId(c))
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List programmable digital employee types',
    },
    (c) => c.json({ items: module.queries.listTypes() }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees/migration-status',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Inspect the single-writer cutover and any draining legacy Missions',
    },
    (c) => c.json(module.queries.getMigrationStatus()),
  )

  if (module.runtime !== null) {
    const runtime = module.runtime

    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/employee-cases',
        permissions: ['digital-employees:read'],
        tokenAccess: 'allow',
        summary: 'List Digital Employee OS cases',
      },
      (c) => {
        const view = z
          .enum(['all', 'active', 'attention', 'finished'])
          .catch('all')
          .parse(c.req.query('view'))
        const rawStates = c.req.query('states')
        const states =
          rawStates === undefined || rawStates === ''
            ? undefined
            : z
                .array(z.enum(['active', 'waiting', 'blocked', 'terminal']))
                .parse(rawStates.split(','))
        return jsonDocumentResponse(
          runtime.queries.listCasePage({
            ...(c.req.query('employeeId') === undefined
              ? {}
              : { employeeId: c.req.query('employeeId')! }),
            ...(states === undefined ? {} : { states }),
            view,
            ...(c.req.query('q') === undefined ? {} : { q: c.req.query('q')! }),
            ...(c.req.query('cursor') === undefined ? {} : { cursor: c.req.query('cursor')! }),
            ...(c.req.query('limit') === undefined
              ? {}
              : {
                  limit: z.coerce.number().int().min(1).max(100).parse(c.req.query('limit')),
                }),
          }),
        )
      },
    )

    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/employee-cases/:id',
        permissions: ['digital-employees:read'],
        tokenAccess: 'allow',
        summary: 'Read context, attention, queue, reaction and next action for one case',
      },
      (c) => jsonDocumentResponse(runtime.queries.getCase(c.req.param('id')).projectionJson),
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/digital-employees/:id/cases',
        permissions: ['development-missions:launch'],
        tokenAccess: 'allow',
        summary: 'Give body, files or an external work item to a digital employee',
      },
      async (c) => {
        const document = runtime.commands.launchWork({
          employeeId: c.req.param('id'),
          intake: await safeJsonOrEmpty(c.req.raw),
          actorUserId: actorId(c),
        })
        return jsonDocumentResponse(document.projectionJson, 201)
      },
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/employee-cases/:id/policy-upgrade-preview',
        permissions: ['development-missions:interact'],
        tokenAccess: 'allow',
        summary: 'Preview an explicit active-case global policy upgrade',
      },
      async (c) => {
        const body = z
          .object({ targetPolicyRevision: z.number().int().positive() })
          .strict()
          .parse(await safeJsonOrEmpty(c.req.raw))
        return c.json({
          previewToken: runtime.commands.previewPolicyUpgrade(
            c.req.param('id'),
            body.targetPolicyRevision,
          ),
        })
      },
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/employee-cases/policy-upgrade-apply',
        permissions: ['development-missions:interact'],
        tokenAccess: 'allow',
        summary: 'Apply a previously previewed active-case policy upgrade',
      },
      async (c) => {
        const body = z
          .object({ previewToken: z.string().min(1) })
          .strict()
          .parse(await safeJsonOrEmpty(c.req.raw))
        const document = runtime.commands.applyPolicyUpgrade(body.previewToken)
        return jsonDocumentResponse(document.projectionJson)
      },
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/employee-cases/:id/resume',
        permissions: ['development-missions:retry'],
        tokenAccess: 'allow',
        summary: 'Resume a blocked employee case after its blocker was resolved',
      },
      (c) => {
        const document = runtime.commands.resume(c.req.param('id'))
        return jsonDocumentResponse(document.projectionJson)
      },
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/employee-cases/:id/terminate',
        permissions: ['development-missions:cancel'],
        tokenAccess: 'allow',
        summary: 'Fence one employee case at an observed external terminal state',
      },
      async (c) => {
        const body = z
          .object({ terminalKind: z.string().min(1) })
          .strict()
          .parse(await safeJsonOrEmpty(c.req.raw))
        const document = runtime.commands.terminate(c.req.param('id'), body.terminalKind)
        return jsonDocumentResponse(document.projectionJson)
      },
    )

    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/employee-cases/worker/run-one',
        permissions: ['development-missions:retry'],
        tokenAccess: 'never',
        summary: 'Run one recoverable Digital Employee OS worker cycle',
      },
      async (c) => {
        const channel = runtime.worker.publishOneChannelResult()
        if (channel !== 'idle') return c.json({ activity: 'channel', state: channel })
        const outbox = await runtime.worker.runOneOutbox()
        if (outbox !== 'idle') return c.json({ activity: 'outbox', state: outbox })
        if (runtime.worker.pumpOneDelivery()) {
          return c.json({ activity: 'delivery', state: 'completed' })
        }
        const roundId = runtime.worker.planOneReaction()
        if (roundId !== null) return c.json({ activity: 'reaction', state: roundId })
        return c.json({
          activity: 'execution',
          state: await runtime.worker.inspectOneExecution(),
        })
      },
    )
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read one exact digital employee type package',
    },
    (c) => c.json(module.queries.getType(parseEmployeeTypeRef(c.req.param('typeRef')))),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef/authoring-manifest',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read the fixed responsibility graph for a digital employee type',
    },
    (c) =>
      c.json(module.queries.getAuthoringManifest(parseEmployeeTypeRef(c.req.param('typeRef')))),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List tools registered for one exact work item contract',
    },
    (c) =>
      c.json({
        items: module.queries.listTools(
          parseEmployeeTypeRef(c.req.param('typeRef')),
          c.req.param('workItemRef'),
        ),
      }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Read the editable authoring body for one work-item tool registration',
    },
    async (c) =>
      c.json(
        await module.queries.getToolAuthoring({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          workItemRef: c.req.param('workItemRef'),
          toolId: c.req.param('toolId'),
        }),
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Register a tool directly on one work item',
    },
    async (c) => {
      const body = await safeJsonOrEmpty(c.req.raw)
      const actor = actorForToolAuthoring(c, body)
      const created = await module.commands.createTool({
        typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
        workItemRef: c.req.param('workItemRef'),
        body,
        actorUserId: actor.user.id,
      })
      return c.json(created, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Correct one stable tool registration before publishing its next revision',
    },
    async (c) => {
      const body = await safeJsonOrEmpty(c.req.raw)
      actorForToolAuthoring(c, body)
      return c.json(
        await module.commands.updateTool({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          workItemRef: c.req.param('workItemRef'),
          toolId: c.req.param('toolId'),
          body,
        }),
      )
    },
  )

  for (const action of ['validate', 'publish'] as const) {
    registerRoute(
      app,
      {
        method: 'POST',
        path: `/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId/${action}`,
        permissions: ['digital-employees:update'],
        tokenAccess: 'allow',
        summary: `${action === 'validate' ? 'Validate' : 'Publish'} one work-item tool registration`,
      },
      async (c) => {
        const common = {
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          workItemRef: c.req.param('workItemRef'),
          toolId: c.req.param('toolId'),
        }
        if (action === 'validate') return c.json(await module.commands.validateTool(common))
        const ref = await module.commands.publishTool({
          ...common,
          actorUserId: actorId(c),
        })
        return c.json({ ref })
      },
    )
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId/retire',
      permissions: ['digital-employees:archive'],
      tokenAccess: 'allow',
      summary: 'Retire a work-item tool registration',
    },
    (c) => {
      module.commands.retireTool({
        typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
        workItemRef: c.req.param('workItemRef'),
        toolId: c.req.param('toolId'),
      })
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef/job-templates',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List job templates for one employee type',
    },
    (c) =>
      c.json({
        items: module.queries.listJobTemplates(parseEmployeeTypeRef(c.req.param('typeRef'))),
      }),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-types/:typeRef/job-templates',
      permissions: ['digital-employees:create'],
      tokenAccess: 'allow',
      summary: 'Create a minimal job template with default node tools',
    },
    async (c) =>
      c.json(
        module.commands.createJobTemplate({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          body: await safeJsonOrEmpty(c.req.raw),
          actorUserId: actorId(c),
        }),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/digital-employee-job-templates/:id',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Update a job template draft',
    },
    async (c) =>
      c.json(
        module.commands.updateJobTemplate({
          id: c.req.param('id'),
          body: await safeJsonOrEmpty(c.req.raw),
        }),
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-job-templates/:id/publish',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Publish an immutable job template revision',
    },
    (c) =>
      c.json({
        ref: module.commands.publishJobTemplate({
          id: c.req.param('id'),
          actorUserId: actorId(c),
        }),
      }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employee-types/:typeRef/employees',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List digital employees of one type',
    },
    (c) =>
      c.json({
        items: module.queries.listEmployees(parseEmployeeTypeRef(c.req.param('typeRef'))),
      }),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-types/:typeRef/employees',
      permissions: ['digital-employees:create'],
      tokenAccess: 'allow',
      summary: 'Create a minimal digital employee definition',
    },
    async (c) =>
      c.json(
        module.commands.createEmployee({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          body: await safeJsonOrEmpty(c.req.raw),
          actorUserId: actorId(c),
        }),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List published and draft digital employees across programmable types',
    },
    (c) => c.json({ items: module.queries.listEmployees() }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees/:id',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read a digital employee definition and its published head',
    },
    (c) => c.json(module.queries.getEmployee(c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/digital-employees/:id',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Update a digital employee draft',
    },
    async (c) =>
      c.json(
        module.commands.updateEmployee({
          id: c.req.param('id'),
          body: await safeJsonOrEmpty(c.req.raw),
        }),
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employees/:id/publish',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Publish an employee with exact node tool bindings',
    },
    (c) =>
      c.json({
        ref: module.commands.publishEmployee({
          id: c.req.param('id'),
          actorUserId: actorId(c),
        }),
      }),
  )
}

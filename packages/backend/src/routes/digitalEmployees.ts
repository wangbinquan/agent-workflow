import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResourceAccess } from '@agent-workflow/shared'
import { UpdateMembersBodySchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { z } from 'zod'

import { actorOf } from '@/auth/actor'
import type { DigitalEmployeeModule } from '@/modules/digital-employee/composition'
import { registerRoute } from '@/routes/registry'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import type { AppDeps } from '@/server'
import {
  getCaseMembers,
  loadVisibleCase,
  requireCaseOperator,
  requireCaseOwner,
  updateCaseMembers,
} from '@/services/employeeCaseMembers'
import {
  filterVisibleRows,
  assertNameUnchangedForEditor,
  projectVisibleRowsWithAccess,
  requireResourceEdit,
  requireResourceGovern,
  resourceAclAudienceAuthority,
} from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { assertMembersUsersActive } from '@/services/taskCollab'
import { NotFoundError } from '@/util/errors'
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

function adapterVisibilitySubject(c: Parameters<typeof actorOf>[0]) {
  const actor = actorOf(c)
  return {
    userId: actor.user.id,
    authority: resourceAclAudienceAuthority(actor),
  }
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

export function mountDigitalEmployeeRoutes(
  app: Hono,
  deps: AppDeps,
  module: DigitalEmployeeModule,
): void {
  const maxUploadBytes = 32 * 1024 * 1024

  // RFC-317 T8 / findings.md ACL-02 —— 员工定义是第 13 类 ACL 资源。
  //
  // 表自建起就带完整的行级 ACL 列，但 'employee_definition' 一直不在
  // ACL_RESOURCE_TYPES 里 ⇒ 三列惰性、列表只按 archivedAt 过滤、**全员可见全部
  // 员工定义**。判据与其余 12 类同形，全部留在 transport 层（下面这两个 helper），
  // 模块内部不感知 ACL。
  // RFC-330 —— 列表项同时带上档位（`access`），卡片按档位收敛控件（design §7.1 / X3）。
  const visibleEmployees = async <
    T extends { id: string; ownerUserId: string | null; visibility: 'private' | 'public' },
  >(
    c: Parameters<typeof actorOf>[0],
    rows: readonly T[],
  ): Promise<Array<T & { access: ResourceAccess }>> =>
    projectVisibleRowsWithAccess(deps.db, actorOf(c), 'employee_definition', rows)

  /** 详情/写路径共用：不可见 ⇒ 404 与不存在同形（RFC-248 H9 反枚举）。 */
  const loadVisibleEmployee = async (
    c: Parameters<typeof actorOf>[0],
    id: string,
  ): Promise<{
    id: string
    name: string
    ownerUserId: string | null
    visibility: 'private' | 'public'
  }> => {
    const row = module.queries.getEmployeeAcl(id)
    if (row === null) {
      throw new NotFoundError('employee-definition-not-found', 'digital employee not found')
    }
    const [visible] = await filterVisibleRows(deps.db, actorOf(c), 'employee_definition', [row])
    if (visible === undefined) {
      throw new NotFoundError('employee-definition-not-found', 'digital employee not found')
    }
    return visible
  }

  /**
   * 写路径：先 404 同形，再 RFC-324 内容写判据（owner / `write` 授权 / bypass）⇒ 403。
   *
   * 保存同时会原子创建下一个可执行 revision——按 RFC-324 D8，发布与编辑同档，
   * 所以这条路由整体归内容写。返回当前行与判定，供调用方做改名围栏。
   */
  const requireEditableEmployee = async (
    c: Parameters<typeof actorOf>[0],
    id: string,
  ): Promise<{ name: string; access: ResourceAccess }> => {
    const row = await loadVisibleEmployee(c, id)
    const access = await requireResourceEdit(deps.db, actorOf(c), 'employee_definition', row)
    return { name: row.name, access }
  }

  // RFC-330 —— 工具注册（第 14 类）与岗位模版（第 15 类）的判据，与员工定义同形、
  // 同样只在 transport 层做一次。平台目录工具没有 DB 行：投影为 builtin / public，
  // 可见但任何写都 403 `builtin-readonly`（D9）。
  type ToolAclRow = NonNullable<ReturnType<DigitalEmployeeModule['queries']['getToolAcl']>>
  const loadVisibleTool = async (
    c: Parameters<typeof actorOf>[0],
    toolId: string,
  ): Promise<ToolAclRow> => {
    const row = module.queries.getToolAcl(toolId)
    if (row === null) {
      throw new NotFoundError('employee-tool-not-found', 'tool registration not found')
    }
    if (row.builtin) return row
    const [visible] = await filterVisibleRows(deps.db, actorOf(c), 'employee_tool', [row])
    if (visible === undefined) {
      throw new NotFoundError('employee-tool-not-found', 'tool registration not found')
    }
    return visible
  }
  const requireEditableTool = async (
    c: Parameters<typeof actorOf>[0],
    toolId: string,
  ): Promise<{ row: ToolAclRow; access: ResourceAccess }> => {
    const row = await loadVisibleTool(c, toolId)
    assertNotBuiltin('employee_tool', row)
    const access = await requireResourceEdit(deps.db, actorOf(c), 'employee_tool', row)
    return { row, access }
  }
  const requireGovernableTool = async (
    c: Parameters<typeof actorOf>[0],
    toolId: string,
  ): Promise<ToolAclRow> => {
    const row = await loadVisibleTool(c, toolId)
    assertNotBuiltin('employee_tool', row)
    await requireResourceGovern(deps.db, actorOf(c), 'employee_tool', row)
    return row
  }

  type JobTemplateAclRow = NonNullable<
    ReturnType<DigitalEmployeeModule['queries']['getJobTemplateAcl']>
  >
  const loadVisibleJobTemplate = async (
    c: Parameters<typeof actorOf>[0],
    id: string,
  ): Promise<JobTemplateAclRow> => {
    const row = module.queries.getJobTemplateAcl(id)
    if (row === null) {
      throw new NotFoundError('employee-job-template-not-found', 'job template not found')
    }
    const [visible] = await filterVisibleRows(deps.db, actorOf(c), 'employee_job_template', [row])
    if (visible === undefined) {
      throw new NotFoundError('employee-job-template-not-found', 'job template not found')
    }
    return visible
  }
  const requireEditableJobTemplate = async (
    c: Parameters<typeof actorOf>[0],
    id: string,
  ): Promise<{ row: JobTemplateAclRow; access: ResourceAccess }> => {
    const row = await loadVisibleJobTemplate(c, id)
    const access = await requireResourceEdit(deps.db, actorOf(c), 'employee_job_template', row)
    return { row, access }
  }
  // 只取改名围栏要比对的那一个字符串字段；用 zod 而不是 `as` 转型（routes-no-cast 守卫）。
  const submittedString = (body: unknown, key: string): string | undefined => {
    const parsed = z.record(z.unknown()).safeParse(body)
    const value = parsed.success ? parsed.data[key] : undefined
    return typeof value === 'string' ? value : undefined
  }

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
        path: '/api/employee-cases/:id',
        permissions: ['digital-employees:read'],
        tokenAccess: 'allow',
        summary: 'Read context, attention, queue, reaction and next action for one case',
      },
      (c) => {
        // RFC-330 D19 —— 可见 = 发起人 ∪ 成员 ∪ tasks:read:all ∪ bypass；否则 404 同形。
        const row = loadVisibleCase(runtime, actorOf(c), c.req.param('id'))
        return jsonDocumentResponse(runtime.queries.getCase(row.id).projectionJson)
      },
    )

    // RFC-330 D19/D20 —— 案例成员面，与 GET/PUT /api/tasks/:id/members 同形。
    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/employee-cases/:id/members',
        permissions: ['digital-employees:read'],
        tokenAccess: 'allow',
        summary: 'List employee case members',
      },
      async (c) => {
        const actor = actorOf(c)
        const row = loadVisibleCase(runtime, actor, c.req.param('id'))
        return c.json(await getCaseMembers(deps.db, actor, runtime, row))
      },
    )

    registerRoute(
      app,
      {
        method: 'PUT',
        path: '/api/employee-cases/:id/members',
        // 与 PUT /api/tasks/:id/members 同点：成员管理是通用协作面，不挂类型专属点
        // （rfc317-permission-domain-ownership 的泄漏账本只减不增）。
        permissions: ['tasks:update'],
        // RFC-247 D5 —— a token must NEVER change owner / members.
        tokenAccess: 'never',
        summary: 'Replace employee case members or transfer its owner',
      },
      async (c) => {
        const actor = actorOf(c)
        const parsed = UpdateMembersBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
        if (!parsed.success) {
          throw new ValidationError('members-invalid', 'invalid members payload', {
            issues: parsed.error.issues,
          })
        }
        const row = requireCaseOwner(runtime, actor, c.req.param('id'))
        return c.json(await updateCaseMembers(deps.db, actor, runtime, row, parsed.data))
      },
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
        const intake = await safeJsonOrEmpty(c.req.raw)
        const collaboratorProjection = z
          .object({
            advanced: z
              .object({ collaboratorUserIds: z.array(z.string()).default([]) })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .safeParse(intake)
        if (collaboratorProjection.success) {
          await assertMembersUsersActive(deps.db, {
            members: (collaboratorProjection.data.advanced?.collaboratorUserIds ?? []).map(
              (userId) => ({ userId }),
            ),
          })
        }
        const document = runtime.commands.launchWork({
          employeeId: c.req.param('id'),
          intake,
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
        const row = requireCaseOperator(runtime, actorOf(c), c.req.param('id'))
        return c.json({
          previewToken: runtime.commands.previewPolicyUpgrade(row.id, body.targetPolicyRevision),
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
        requireCaseOperator(
          runtime,
          actorOf(c),
          runtime.queries.peekPolicyUpgradeCaseId(body.previewToken),
        )
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
        const row = requireCaseOperator(runtime, actorOf(c), c.req.param('id'))
        const document = runtime.commands.resume(row.id)
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
        const row = requireCaseOperator(runtime, actorOf(c), c.req.param('id'))
        const document = runtime.commands.terminate(row.id, body.terminalKind)
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
    async (c) => {
      // RFC-330 —— 平台目录工具恒在、恒 `read`；自定义工具按可见性过滤并带档位。
      const items = module.queries.listTools(
        parseEmployeeTypeRef(c.req.param('typeRef')),
        c.req.param('workItemRef'),
      )
      const platform = items
        .filter((tool) => tool.origin === 'platform')
        .map((tool) => ({ ...tool, access: 'read' as const }))
      const custom = await projectVisibleRowsWithAccess(
        deps.db,
        actorOf(c),
        'employee_tool',
        items.filter((tool) => tool.origin !== 'platform'),
      )
      return c.json({ items: [...platform, ...custom] })
    },
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
    async (c) => {
      await loadVisibleTool(c, c.req.param('toolId'))
      return c.json(
        await module.queries.getToolAuthoring({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          workItemRef: c.req.param('workItemRef'),
          toolId: c.req.param('toolId'),
        }),
      )
    },
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
      // RFC-330 —— 内容写（owner / write 授权 / bypass）；显示名视同改名，归 owner（D7）。
      const { row, access } = await requireEditableTool(c, c.req.param('toolId'))
      assertNameUnchangedForEditor(access, row.name, submittedString(body, 'displayName'))
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
        // RFC-330 —— 校验 / 发布与编辑同档（RFC-324 D8）。
        await requireEditableTool(c, common.toolId)
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
    async (c) => {
      // RFC-330 D8 —— 退休（含删草稿）是治理写：owner / bypass。
      await requireGovernableTool(c, c.req.param('toolId'))
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
    async (c) =>
      c.json({
        items: await projectVisibleRowsWithAccess(
          deps.db,
          actorOf(c),
          'employee_job_template',
          module.queries.listJobTemplates(parseEmployeeTypeRef(c.req.param('typeRef'))),
        ),
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
          adapterVisibilitySubject: adapterVisibilitySubject(c),
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
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      // RFC-330 —— 内容写；`name` 变更归 owner（RFC-324 D3）。
      const { row, access } = await requireEditableJobTemplate(c, id)
      assertNameUnchangedForEditor(access, row.name, submittedString(body, 'name'))
      return c.json(
        module.commands.updateJobTemplate({
          id,
          body,
          adapterVisibilitySubject: adapterVisibilitySubject(c),
        }),
      )
    },
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
    async (c) => {
      const id = c.req.param('id')
      await requireEditableJobTemplate(c, id)
      return c.json({
        ref: module.commands.publishJobTemplate({
          id,
          actorUserId: actorId(c),
          adapterVisibilitySubject: adapterVisibilitySubject(c),
        }),
      })
    },
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
    async (c) =>
      c.json({
        items: await visibleEmployees(
          c,
          module.queries.listEmployees(parseEmployeeTypeRef(c.req.param('typeRef'))),
        ),
      }),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/digital-employee-types/:typeRef/employees',
      permissions: ['digital-employees:create'],
      tokenAccess: 'allow',
      summary: 'Create a digital employee with its first executable revision',
    },
    async (c) =>
      c.json(
        module.commands.createEmployee({
          typeRef: parseEmployeeTypeRef(c.req.param('typeRef')),
          body: await safeJsonOrEmpty(c.req.raw),
          actorUserId: actorId(c),
          adapterVisibilitySubject: adapterVisibilitySubject(c),
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
      summary: 'List digital employees across programmable types',
    },
    async (c) => c.json({ items: await visibleEmployees(c, module.queries.listEmployees()) }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees/outcome-summaries',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List terminal EmployeeCase outcome groups for every digital employee',
    },
    (c) =>
      c.json({
        items:
          module.runtime === null
            ? []
            : (JSON.parse(module.runtime.queries.listTerminalOutcomeGroups()) as unknown[]),
      }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees/launchable',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List digital employees pinned to the current installed type revision',
    },
    async (c) =>
      c.json({ items: await visibleEmployees(c, module.queries.listLaunchableEmployees()) }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/digital-employees/:id',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read a digital employee definition and its current revision',
    },
    async (c) => {
      const id = c.req.param('id')
      await loadVisibleEmployee(c, id)
      return c.json(module.queries.getEmployee(id))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/digital-employees/:id',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Save a digital employee and atomically create its next executable revision',
    },
    async (c) => {
      const id = c.req.param('id')
      const { name, access } = await requireEditableEmployee(c, id)
      const body = await safeJsonOrEmpty(c.req.raw)
      // RFC-324 —— 保存 body 带 name（updateEmployeeDefinitionBodySchema），改名归 owner。
      const submittedName = (body as { name?: unknown }).name
      assertNameUnchangedForEditor(
        access,
        name,
        typeof submittedName === 'string' ? submittedName : undefined,
      )
      return c.json(
        module.commands.updateEmployee({
          id,
          body,
          actorUserId: actorId(c),
          adapterVisibilitySubject: adapterVisibilitySubject(c),
        }),
      )
    },
  )

  // RFC-317 T8 —— 授权管理端点。base 是 `/api/digital-employees`，与 RFC-310 配置
  // 资源的 `/api/code/digital-employees` 不同前缀，路径不冲突。
  mountAclEndpoints(app, deps, {
    type: 'employee_definition',
    base: '/api/digital-employees',
    param: 'id',
    load: async (_db, key) => module.queries.getEmployeeAcl(key),
  })

  // RFC-330 —— 工具注册 / 岗位模版的授权管理端点（第 14 / 15 类）。平台目录工具
  // 没有 ACL 行：`load` 返回 null ⇒ GET / PUT `/acl` 都 404（D9）。
  mountAclEndpoints(app, deps, {
    type: 'employee_tool',
    base: '/api/digital-employee-tools',
    param: 'id',
    notFoundCode: 'employee-tool-not-found',
    load: async (_db, key) => {
      const row = module.queries.getToolAcl(key)
      return row === null || row.builtin ? null : row
    },
  })
  mountAclEndpoints(app, deps, {
    type: 'employee_job_template',
    base: '/api/digital-employee-job-templates',
    param: 'id',
    notFoundCode: 'employee-job-template-not-found',
    load: async (_db, key) => module.queries.getJobTemplateAcl(key),
  })
}

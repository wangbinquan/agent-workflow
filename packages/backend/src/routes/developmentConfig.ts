// RFC-310 PR-1B —— 数字员工配置资源的 HTTP 面（design.md §12.2）。
//
// 五类资源（action-templates / verification-profiles / digital-employees /
// automation-policies / development-adapters）共用同一 CRUD 形态：identity 可
// 见性走 RFC-099 行级 ACL，publish 产 immutable revision。另有 repository
// assignment（每 scope 至多一份）与两个 preview 端点（T19 simulate 面：与
// 真实运行同一 pure evaluator，不 claim lease、不写 receipt）。
//
// route 是装配点（identity-access `auth/actor.ts:14` 同款惯例）：在这里构造
// sqlite store 注入 application commands；permission 门统一走 registerRoute。

import type { Hono } from 'hono'
import { z } from 'zod'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import {
  archiveActionTemplate,
  createActionTemplate,
  publishActionTemplate,
  reviseActionTemplateDraft,
} from '@/modules/development-automation/application/commands/actionTemplateCommands'
import {
  archiveVerificationProfile,
  createVerificationProfile,
  publishVerificationProfile,
  reviseVerificationProfileDraft,
} from '@/modules/development-automation/application/commands/verificationProfileCommands'
import {
  archiveDigitalEmployee,
  createDigitalEmployee,
  getDigitalEmployee,
  listDigitalEmployees,
  publishDigitalEmployee,
  reviseDigitalEmployeeDraft,
  createAutomationPolicy,
  getAutomationPolicy,
  listAutomationPolicies,
  reviseAutomationPolicyDraft,
  publishAutomationPolicy,
  archiveAutomationPolicy,
} from '@/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  deleteAssignment,
  listAssignments,
  upsertAssignment,
} from '@/modules/development-automation/infrastructure/sqliteAssignmentStore'
import {
  createSqliteActionTemplateStore,
  createSqliteVerificationProfileStore,
} from '@/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { createEmployeePublishLookup } from '@/modules/development-automation/infrastructure/publishLookup'
import {
  archiveDevelopmentAdapter,
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
} from '@/modules/integration/application/developmentAdapterCommands'
import { createSqliteDevelopmentAdapterStore } from '@/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import { evaluatePolicy } from '@/modules/development-automation/engine/policy/evaluatePolicy'
import { resolveEmployeeSelection } from '@/modules/development-automation/engine/policy/workSelection'
import { buildFactSnapshot } from '@/modules/development-automation/domain/facts'
import { factCellSchema } from '@/modules/development-automation/domain/factCell'
import { nextDecisionSchema } from '@/modules/development-automation/domain/decision'
import { factPredicateSchema } from '@/modules/development-automation/domain/predicate'
import {
  compileEmployeePlaybook,
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
} from '@/modules/development-automation/domain/digitalEmployee'
import { projectEmployeeSetupJourney } from '@/modules/development-automation/domain/journeyProjection'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import type { AclResourceType } from '@agent-workflow/shared'
import type { AppDeps } from '@/server'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

type PermissionPrefix =
  | 'action-templates'
  | 'verification-profiles'
  | 'digital-employees'
  | 'automation-policies'
  | 'adapter-definitions'

interface IdentityView {
  id: string
  name: string
  publishedRevision: number | null
  ownerUserId: string | null
  visibility: 'private' | 'public'
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  [key: string]: unknown
}

interface ResourceHandlers {
  list(actor: Actor): Promise<IdentityView[]>
  get(actor: Actor, id: string): Promise<(IdentityView & { draft: unknown }) | null>
  create(
    actor: Actor,
    body: { name: string; draft: unknown; extra: Record<string, unknown> },
  ): Promise<IdentityView>
  revise(actor: Actor, id: string, body: { name?: string; draft?: unknown }): Promise<void>
  publish(actor: Actor, id: string): Promise<{ revision: number; contentDigest: string }>
  archive(actor: Actor, id: string): Promise<void>
}

const createBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    draft: z.unknown().optional(),
    capabilityId: z.string().min(1).optional(),
    purpose: z
      .enum(['requirement-source', 'pipeline-gate', 'pipeline-classifier', 'approval-gateway'])
      .optional(),
  })
  .strict()

const reviseBodySchema = z
  .object({ name: z.string().min(1).max(200).optional(), draft: z.unknown() })
  .strict()

function mountConfigResource(
  app: Hono,
  deps: AppDeps,
  cfg: {
    base: string
    permissionPrefix: PermissionPrefix
    aclType: AclResourceType
    summaryNoun: string
    handlers: ResourceHandlers
    loadAclRow: (db: AppDeps['db'], id: string) => Promise<AclVisibleRow | null>
  },
): void {
  const perm = (verb: 'read' | 'create' | 'update' | 'archive') =>
    [`${cfg.permissionPrefix}:${verb}`] as const

  registerRoute(
    app,
    {
      method: 'GET',
      path: cfg.base,
      permissions: [...perm('read')],
      tokenAccess: 'allow',
      summary: `List visible ${cfg.summaryNoun}s`,
    },
    async (c) => {
      const rows = await cfg.handlers.list(actorOf(c))
      return c.json({ items: rows })
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: cfg.base,
      permissions: [...perm('create')],
      tokenAccess: 'allow',
      summary: `Create a ${cfg.summaryNoun} draft`,
    },
    async (c) => {
      const body = createBodySchema.parse(await safeJsonOrEmpty(c.req.raw))
      const { name, draft, ...extra } = body
      const created = await cfg.handlers.create(actorOf(c), {
        name,
        draft: draft ?? {},
        extra,
      })
      return c.json(created, 201)
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: `${cfg.base}/:id`,
      permissions: [...perm('read')],
      tokenAccess: 'allow',
      summary: `Read one ${cfg.summaryNoun} (draft + published head)`,
    },
    async (c) => {
      const found = await cfg.handlers.get(actorOf(c), c.req.param('id'))
      if (found === null) throw new NotFoundError(`${cfg.permissionPrefix}-not-found`, 'not found')
      return c.json(found)
    },
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: `${cfg.base}/:id`,
      permissions: [...perm('update')],
      tokenAccess: 'allow',
      summary: `Revise a ${cfg.summaryNoun} draft`,
    },
    async (c) => {
      const body = reviseBodySchema.parse(await safeJsonOrEmpty(c.req.raw))
      await cfg.handlers.revise(actorOf(c), c.req.param('id'), body)
      return c.json({ ok: true })
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: `${cfg.base}/:id/publish`,
      permissions: [...perm('update')],
      tokenAccess: 'allow',
      summary: `Publish an immutable ${cfg.summaryNoun} revision`,
    },
    async (c) => {
      const receipt = await cfg.handlers.publish(actorOf(c), c.req.param('id'))
      return c.json(receipt)
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: `${cfg.base}/:id/archive`,
      permissions: [...perm('archive')],
      tokenAccess: 'allow',
      summary: `Archive a ${cfg.summaryNoun} (references stay resolvable)`,
    },
    async (c) => {
      await cfg.handlers.archive(actorOf(c), c.req.param('id'))
      return c.json({ ok: true })
    },
  )
  mountAclEndpoints(app, deps, {
    type: cfg.aclType,
    base: cfg.base,
    param: 'id',
    load: (db, key) => cfg.loadAclRow(db, key),
  })
}

interface AclVisibleRow {
  id: string
  ownerUserId: string | null
  visibility: 'private' | 'public'
}

async function requireVisible<T extends AclVisibleRow>(
  deps: AppDeps,
  actor: Actor,
  aclType: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null || !(await canViewResource(deps.db, actor, aclType, row))) {
    throw new NotFoundError('resource-not-found', 'not found')
  }
  return row
}

/**
 * 写门（revise / publish / archive / playbook PUT）。
 *
 * RFC-317 C1 之前，这五类资源的写路径只调 `requireVisible`——即**看得见就写得动**。
 * 而 `user` 角色预设本就持有这五类的 `:update` / `:archive` 点
 * （`shared/schemas/permission.ts` 的 `USER_RESOURCE_WRITES`），于是任何登录用户
 * 都能改写 / 发布 / 归档**别人的** public 动作模板、验证档案、数字员工、自动化
 * 策略与适配器定义。同一份 permission 文件的注释却写着「per-row check 是
 * resource ACL，和这里其他类型一样」——名实不符。
 *
 * 现在与其余七类 ACL 资源走同一个公共判据 `requireResourceOwner`：它先做
 * `requireResourceView`（不可见 ⇒ 404，与不存在同形，守 RFC-248 H9 反枚举），
 * 再判 owner-or-bypass（可见但非 owner ⇒ 403）。
 *
 * **注意 grant 不含写权**：`resource_grants` 只进 `canViewResource`，不进
 * `isResourceOwner`（`services/resourceAcl.ts`）。所以「授权给某人」只授可见与
 * 可用；非 owner 要写只有三条路——由 owner 操作、授 `resource-acl:bypass`
 * （manager+ 才有此点）、或转移 owner。
 */
async function requireOwned<T extends AclVisibleRow>(
  deps: AppDeps,
  actor: Actor,
  aclType: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null) throw new NotFoundError('resource-not-found', 'not found')
  await requireResourceOwner(deps.db, actor, aclType, row)
  return row
}

export function mountDevelopmentConfigRoutes(app: Hono, deps: AppDeps): void {
  const templateStore = createSqliteActionTemplateStore(deps.db)
  const profileStore = createSqliteVerificationProfileStore(deps.db)
  const adapterStore = createSqliteDevelopmentAdapterStore(deps.db)
  const now = () => Date.now()

  const identityView = (r: {
    id: string
    name: string
    publishedRevision: number | null
    ownerUserId: string | null
    visibility: 'private' | 'public'
    createdAt: number
    updatedAt: number
    archivedAt: number | null
  }): IdentityView => ({
    id: r.id,
    name: r.name,
    publishedRevision: r.publishedRevision,
    ownerUserId: r.ownerUserId,
    visibility: r.visibility,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  })

  // ---- action templates ----------------------------------------------------
  mountConfigResource(app, deps, {
    base: '/api/code/action-templates',
    permissionPrefix: 'action-templates',
    aclType: 'action_template',
    summaryNoun: 'action template',
    loadAclRow: async (_db, id) => templateStore.getById(id),
    handlers: {
      list: async (actor) =>
        (await filterVisibleRows(deps.db, actor, 'action_template', templateStore.list())).map(
          (r) => {
            const published =
              r.publishedRevision === null
                ? null
                : templateStore.getRevision(r.id, r.publishedRevision)
            let executorKind: 'agent' | 'workgroup' | 'script' | null = null
            if (published !== null) {
              const content = JSON.parse(published.contentJson) as {
                executor?: { kind?: unknown }
              }
              if (
                content.executor?.kind === 'agent' ||
                content.executor?.kind === 'workgroup' ||
                content.executor?.kind === 'script'
              ) {
                executorKind = content.executor.kind
              }
            }
            return {
              ...identityView(r),
              capabilityId: r.extra.capabilityId,
              executorKind,
            }
          },
        ),
      get: async (actor, id) => {
        const row = await requireVisible(deps, actor, 'action_template', templateStore.getById(id))
        const record = templateStore.getById(id)!
        return {
          ...identityView(record),
          capabilityId: record.extra.capabilityId,
          draft: JSON.parse(row.draftJson),
        }
      },
      create: async (actor, body) => {
        const capabilityId = body.extra.capabilityId
        if (typeof capabilityId !== 'string') {
          throw new ValidationError(
            'action-template-capability-required',
            'capabilityId is required',
          )
        }
        return identityView(
          createActionTemplate(
            { store: templateStore, now },
            { actorUserId: actor.user.id, name: body.name, capabilityId, draft: body.draft },
          ),
        )
      },
      revise: async (actor, id, body) => {
        await requireOwned(deps, actor, 'action_template', templateStore.getById(id))
        reviseActionTemplateDraft(
          { store: templateStore, now },
          { id, draft: body.draft ?? {}, ...(body.name === undefined ? {} : { name: body.name }) },
        )
      },
      publish: async (actor, id) => {
        await requireOwned(deps, actor, 'action_template', templateStore.getById(id))
        return publishActionTemplate(
          { store: templateStore, now },
          { id, actorUserId: actor.user.id },
        )
      },
      archive: async (actor, id) => {
        await requireOwned(deps, actor, 'action_template', templateStore.getById(id))
        archiveActionTemplate({ store: templateStore, now }, { id })
      },
    },
  })

  // ---- verification profiles ----------------------------------------------
  mountConfigResource(app, deps, {
    base: '/api/code/verification-profiles',
    permissionPrefix: 'verification-profiles',
    aclType: 'verification_profile',
    summaryNoun: 'verification profile',
    loadAclRow: async (_db, id) => profileStore.getById(id),
    handlers: {
      list: async (actor) =>
        (await filterVisibleRows(deps.db, actor, 'verification_profile', profileStore.list())).map(
          (r) => identityView(r),
        ),
      get: async (actor, id) => {
        const row = await requireVisible(
          deps,
          actor,
          'verification_profile',
          profileStore.getById(id),
        )
        return { ...identityView(row), draft: JSON.parse(row.draftJson) }
      },
      create: async (actor, body) =>
        identityView(
          createVerificationProfile(
            { store: profileStore, now },
            { actorUserId: actor.user.id, name: body.name, draft: body.draft },
          ),
        ),
      revise: async (actor, id, body) => {
        await requireOwned(deps, actor, 'verification_profile', profileStore.getById(id))
        reviseVerificationProfileDraft(
          { store: profileStore, now },
          { id, draft: body.draft ?? {}, ...(body.name === undefined ? {} : { name: body.name }) },
        )
      },
      publish: async (actor, id) => {
        await requireOwned(deps, actor, 'verification_profile', profileStore.getById(id))
        return publishVerificationProfile(
          { store: profileStore, now },
          { id, actorUserId: actor.user.id },
        )
      },
      archive: async (actor, id) => {
        await requireOwned(deps, actor, 'verification_profile', profileStore.getById(id))
        archiveVerificationProfile({ store: profileStore, now }, { id })
      },
    },
  })

  // ---- digital employees ---------------------------------------------------
  mountConfigResource(app, deps, {
    base: '/api/code/digital-employees',
    permissionPrefix: 'digital-employees',
    aclType: 'digital_employee',
    summaryNoun: 'digital employee',
    loadAclRow: (db, id) => getDigitalEmployee(db, id),
    handlers: {
      list: async (actor) =>
        (
          await filterVisibleRows(
            deps.db,
            actor,
            'digital_employee',
            await listDigitalEmployees(deps.db),
          )
        ).map((r) => {
          const draft = JSON.parse(r.draftJson) as {
            description?: unknown
            businessStatus?: unknown
            steps?: unknown
          }
          return {
            ...identityView(r),
            description: typeof draft.description === 'string' ? draft.description : '',
            businessStatus: draft.businessStatus === 'disabled' ? 'disabled' : 'enabled',
            stepCount: Array.isArray(draft.steps) ? draft.steps.length : 0,
          }
        }),
      get: async (actor, id) => {
        const row = await requireVisible(
          deps,
          actor,
          'digital_employee',
          await getDigitalEmployee(deps.db, id),
        )
        return { ...identityView(row), draft: JSON.parse(row.draftJson) }
      },
      create: async (actor, body) =>
        identityView(
          await createDigitalEmployee(deps.db, {
            name: body.name,
            ownerUserId: actor.user.id,
            draft: body.draft,
          }),
        ),
      revise: async (actor, id, body) => {
        await requireOwned(deps, actor, 'digital_employee', await getDigitalEmployee(deps.db, id))
        await reviseDigitalEmployeeDraft(deps.db, {
          id,
          draft: body.draft ?? {},
          ...(body.name === undefined ? {} : { name: body.name }),
        })
      },
      publish: async (actor, id) => {
        await requireOwned(deps, actor, 'digital_employee', await getDigitalEmployee(deps.db, id))
        return publishDigitalEmployee(deps.db, {
          id,
          publishedBy: actor.user.id,
          lookup: createEmployeePublishLookup(deps.db),
        })
      },
      archive: async (actor, id) => {
        await requireOwned(deps, actor, 'digital_employee', await getDigitalEmployee(deps.db, id))
        await archiveDigitalEmployee(deps.db, id)
      },
    },
  })

  // ---- business playbook aggregate + setup journey (PR-11/PR-13) ----------
  // The generic CRUD remains an advanced compatibility surface. Business UI
  // reads/writes one employee playbook and receives the same server-owned
  // next-action projection used by /code.
  const employeePlaybookBody = z
    .object({
      name: z.string().min(1).max(200).optional(),
      playbook: z.unknown(),
    })
    .strict()

  const playbookProjection = async (actor: Actor, id: string) => {
    const row = await requireVisible(
      deps,
      actor,
      'digital_employee',
      await getDigitalEmployee(deps.db, id),
    )
    const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(row.draftJson))
    const violations = parsed.success
      ? validateDigitalEmployeeForPublish(parsed.data, createEmployeePublishLookup(deps.db))
      : parsed.error.issues.map((issue) => ({
          code: 'playbook-schema-invalid',
          where: issue.path.join('/'),
          detail: issue.message,
        }))
    const assignments = await listAssignments(deps.db)
    const hasAssignment = assignments.some((assignment) => assignment.employeeId === id)
    return {
      ...identityView(row),
      playbook: JSON.parse(row.draftJson) as unknown,
      compiled: parsed.success ? compileEmployeePlaybook(parsed.data) : null,
      violations,
      readyToPublish: parsed.success && violations.length === 0,
      assignmentCount: assignments.filter((assignment) => assignment.employeeId === id).length,
      journey: projectEmployeeSetupJourney({
        employee: {
          id,
          publishedRevision: row.publishedRevision,
          archived: row.archivedAt !== null,
          hasAssignment,
        },
        canCreate: actor.permissions.has('digital-employees:create'),
        canUpdate: actor.permissions.has('digital-employees:update'),
        canAssign: actor.permissions.has('repository-employee-assignments:update'),
        canLaunch: actor.permissions.has('development-missions:launch'),
        readyToPublish: parsed.success && violations.length === 0,
      }),
    }
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/digital-employees/:id/playbook',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read one business digital-employee playbook with validation and next action',
    },
    async (c) => c.json(await playbookProjection(actorOf(c), c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/code/digital-employees/:id/playbook',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Revise one complete business digital-employee playbook',
    },
    async (c) => {
      const actor = actorOf(c)
      const id = c.req.param('id')
      await requireOwned(deps, actor, 'digital_employee', await getDigitalEmployee(deps.db, id))
      const body = employeePlaybookBody.parse(await safeJsonOrEmpty(c.req.raw))
      // Reject an incomplete browser write before replacing the previous draft;
      // cross-resource closure violations remain visible and publish-blocking.
      digitalEmployeeContentSchema.parse(body.playbook)
      await reviseDigitalEmployeeDraft(deps.db, {
        id,
        draft: body.playbook,
        ...(body.name === undefined ? {} : { name: body.name }),
      })
      return c.json({ ok: true, nextLocation: `/code/config/employees/${encodeURIComponent(id)}` })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/digital-employees/:id/playbook/validate',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Validate and compile the current business digital-employee playbook',
    },
    async (c) => {
      const projection = await playbookProjection(actorOf(c), c.req.param('id'))
      return c.json({
        readyToPublish: projection.readyToPublish,
        violations: projection.violations,
        compiled: projection.compiled,
        journey: projection.journey,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/setup-journey',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read the single next action for first-time digital-employee setup',
    },
    async (c) => {
      const actor = actorOf(c)
      const visible = await filterVisibleRows(
        deps.db,
        actor,
        'digital_employee',
        await listDigitalEmployees(deps.db),
      )
      const assignments = await listAssignments(deps.db)
      const hasAssignment = (id: string): boolean =>
        assignments.some((assignment) => assignment.employeeId === id)
      const requestedEmployee = c.req.query('employee')
      const selected =
        (requestedEmployee === undefined
          ? undefined
          : visible.find((employee) => employee.id === requestedEmployee)) ??
        visible.find(
          (employee) => employee.archivedAt === null && employee.publishedRevision === null,
        ) ??
        visible.find(
          (employee) =>
            employee.archivedAt === null &&
            employee.publishedRevision !== null &&
            !hasAssignment(employee.id),
        ) ??
        visible.find((employee) => employee.archivedAt === null) ??
        visible[0] ??
        null
      const selectedDraft =
        selected === null
          ? null
          : digitalEmployeeContentSchema.safeParse(JSON.parse(selected.draftJson))
      const selectedReadyToPublish =
        selectedDraft?.success === true &&
        validateDigitalEmployeeForPublish(selectedDraft.data, createEmployeePublishLookup(deps.db))
          .length === 0
      return c.json(
        projectEmployeeSetupJourney({
          employee:
            selected === null
              ? null
              : {
                  id: selected.id,
                  publishedRevision: selected.publishedRevision,
                  archived: selected.archivedAt !== null,
                  hasAssignment: hasAssignment(selected.id),
                },
          canCreate: actor.permissions.has('digital-employees:create'),
          canUpdate: actor.permissions.has('digital-employees:update'),
          canAssign: actor.permissions.has('repository-employee-assignments:update'),
          canLaunch: actor.permissions.has('development-missions:launch'),
          readyToPublish: selectedReadyToPublish,
        }),
      )
    },
  )

  // ---- automation policies -------------------------------------------------
  mountConfigResource(app, deps, {
    base: '/api/code/automation-policies',
    permissionPrefix: 'automation-policies',
    aclType: 'automation_policy',
    summaryNoun: 'automation policy',
    loadAclRow: (db, id) => getAutomationPolicy(db, id),
    handlers: {
      list: async (actor) =>
        (
          await filterVisibleRows(
            deps.db,
            actor,
            'automation_policy',
            await listAutomationPolicies(deps.db),
          )
        ).map((r) => identityView(r)),
      get: async (actor, id) => {
        const row = await requireVisible(
          deps,
          actor,
          'automation_policy',
          await getAutomationPolicy(deps.db, id),
        )
        return { ...identityView(row), draft: JSON.parse(row.draftJson) }
      },
      create: async (actor, body) =>
        identityView(
          await createAutomationPolicy(deps.db, {
            name: body.name,
            ownerUserId: actor.user.id,
            draft: body.draft,
          }),
        ),
      revise: async (actor, id, body) => {
        await requireOwned(deps, actor, 'automation_policy', await getAutomationPolicy(deps.db, id))
        await reviseAutomationPolicyDraft(deps.db, {
          id,
          draft: body.draft ?? {},
          ...(body.name === undefined ? {} : { name: body.name }),
        })
      },
      publish: async (actor, id) => {
        await requireOwned(deps, actor, 'automation_policy', await getAutomationPolicy(deps.db, id))
        return publishAutomationPolicy(deps.db, { id, publishedBy: actor.user.id })
      },
      archive: async (actor, id) => {
        await requireOwned(deps, actor, 'automation_policy', await getAutomationPolicy(deps.db, id))
        await archiveAutomationPolicy(deps.db, id)
      },
    },
  })

  // ---- development adapters (integration-owned) ---------------------------
  mountConfigResource(app, deps, {
    base: '/api/integrations/development-adapters',
    permissionPrefix: 'adapter-definitions',
    aclType: 'development_adapter',
    summaryNoun: 'development adapter',
    loadAclRow: async (_db, id) => adapterStore.getById(id),
    handlers: {
      list: async (actor) =>
        (await filterVisibleRows(deps.db, actor, 'development_adapter', adapterStore.list())).map(
          (r) => ({ ...identityView(r), purpose: (r as { purpose?: unknown }).purpose }),
        ),
      get: async (actor, id) => {
        if (
          !actor.permissions.has('adapter-definitions:update') ||
          !actor.permissions.has('scripts:author')
        ) {
          throw new ForbiddenError(
            'adapter-technical-details-forbidden',
            'reading Adapter executable and secret projection names requires adapter-definitions:update and scripts:author',
          )
        }
        const row = await requireOwned(deps, actor, 'development_adapter', adapterStore.getById(id))
        return {
          ...identityView(row),
          purpose: (row as { purpose?: unknown }).purpose,
          draft: JSON.parse(row.draftJson),
        }
      },
      create: async (actor, body) => {
        const purpose = body.extra.purpose
        if (typeof purpose !== 'string') {
          throw new ValidationError('development-adapter-purpose-required', 'purpose is required')
        }
        return identityView(
          createDevelopmentAdapter(
            adapterStore,
            {
              userId: actor.user.id,
              actorHasScriptsAuthor: actor.permissions.has('scripts:author'),
            },
            // adapter 的 draft 在写入时即 strict parse + scripts:author 字段门：
            // 与其他四类「draft 宽容」不同——可执行引用不允许以草稿形态潜伏。
            {
              name: body.name,
              content: {
                ...(typeof body.draft === 'object' && body.draft !== null ? body.draft : {}),
                purpose,
              },
              now: now(),
            },
          ),
        )
      },
      revise: async (actor, id, body) => {
        await requireOwned(deps, actor, 'development_adapter', adapterStore.getById(id))
        reviseDevelopmentAdapterDraft(
          adapterStore,
          { userId: actor.user.id, actorHasScriptsAuthor: actor.permissions.has('scripts:author') },
          { id, content: body.draft ?? {}, now: now() },
        )
      },
      publish: async (actor, id) => {
        await requireOwned(deps, actor, 'development_adapter', adapterStore.getById(id))
        return publishDevelopmentAdapter(
          adapterStore,
          { userId: actor.user.id, actorHasScriptsAuthor: actor.permissions.has('scripts:author') },
          { id, now: now() },
        )
      },
      archive: async (actor, id) => {
        await requireOwned(deps, actor, 'development_adapter', adapterStore.getById(id))
        archiveDevelopmentAdapter(adapterStore, { id, now: now() })
      },
    },
  })

  // ---- repository assignments (T17) ---------------------------------------
  const assignmentBody = z
    .object({
      scopeKind: z.enum(['repository', 'repository-group', 'global-default']),
      scopeRef: z.string().min(1).nullable(),
      employee: z
        .object({ id: z.string().min(1), revision: z.number().int().positive() })
        .strict()
        .nullable(),
      selectionPolicy: z
        .object({ id: z.string().min(1), revision: z.number().int().positive() })
        .strict()
        .nullable(),
      executionPolicy: z
        .object({ id: z.string().min(1), revision: z.number().int().positive() })
        .strict()
        .nullable(),
      defaultRequirementSourceKey: z.string().min(1).nullable(),
    })
    .strict()

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/repository-assignments',
      permissions: ['repository-employee-assignments:read'],
      tokenAccess: 'allow',
      summary: 'List repository/group/global digital-employee assignments',
    },
    async (c) => c.json({ items: await listAssignments(deps.db) }),
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/code/repository-assignments',
      permissions: ['repository-employee-assignments:update'],
      tokenAccess: 'allow',
      summary: 'Upsert the single assignment for one scope',
    },
    async (c) => {
      const body = assignmentBody.parse(await safeJsonOrEmpty(c.req.raw))
      const view = await upsertAssignment(deps.db, { ...body, updatedBy: actorOf(c).user.id })
      return c.json(view)
    },
  )
  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/code/repository-assignments/:scopeKind',
      permissions: ['repository-employee-assignments:update'],
      tokenAccess: 'allow',
      summary: 'Delete the assignment for one scope (scopeRef via query)',
    },
    async (c) => {
      const scopeKind = z
        .enum(['repository', 'repository-group', 'global-default'])
        .parse(c.req.param('scopeKind'))
      const scopeRef = c.req.query('scopeRef') ?? null
      await deleteAssignment(deps.db, scopeKind, scopeRef)
      return c.json({ ok: true })
    },
  )

  // ---- previews (T19 simulate; same pure evaluator as production) ----------
  const guardSchema = z
    .object({
      missionTerminal: z.boolean(),
      mrTerminal: z.enum(['active', 'merged', 'closed', 'not-applicable']),
      holdsLease: z.boolean(),
      activeWritableAction: z.boolean(),
      unsettledEffect: z.boolean(),
      transitionFence: z.enum(['none', 'cancel-pending', 'handoff-pending']),
      factIntegrityViolations: z.array(z.string()),
      staleBaseline: z.boolean(),
      authorityViolations: z.array(z.string()),
      exhaustedBudgets: z.array(z.string()),
      automationMode: z.enum(['active', 'tracking-only']),
      uploadSeed: z.enum(['not-applicable', 'pending', 'seeded', 'published']),
      uploadPlanRef: z.string().nullable(),
    })
    .strict()

  const cellsSchema = z.record(
    factCellSchema(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/automation-policies/preview-decision',
      permissions: ['automation-policies:read'],
      tokenAccess: 'allow',
      summary: 'Simulate the fixed-guard + first-match evaluator on fixture facts',
    },
    async (c) => {
      const body = z
        .object({
          guards: guardSchema,
          cells: cellsSchema,
          rules: z.array(
            z
              .object({
                ruleId: z.string().min(1),
                when: z.array(factPredicateSchema),
                decision: nextDecisionSchema,
              })
              .strict(),
          ),
        })
        .strict()
        .parse(await safeJsonOrEmpty(c.req.raw))
      const snapshot = buildFactSnapshot({
        missionRevision: 0,
        capturedAt: '1970-01-01T00:00:00+00:00',
        cells: body.cells,
      })
      const result = evaluatePolicy({
        guards: body.guards,
        snapshot,
        rules: body.rules,
      })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/digital-employees/preview-selection',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Simulate deterministic employee selection on fixture facts',
    },
    async (c) => {
      const ruleSchema = z
        .object({
          ruleId: z.string().min(1),
          when: z.array(factPredicateSchema),
          employeeRef: z.string().min(1),
        })
        .strict()
      const body = z
        .object({
          explicitEmployeeRef: z.string().min(1).nullable(),
          assignment: z
            .object({
              scope: z.enum(['repository', 'repository-group', 'global-default']),
              employeeRef: z.string().min(1).nullable(),
              selectionRules: z.array(ruleSchema).nullable(),
              executionPolicyRef: z.string().min(1).nullable(),
              defaultRequirementSourceKey: z.string().min(1).nullable(),
            })
            .strict()
            .nullable(),
          explicitFallbackRef: z.string().min(1).nullable(),
          cells: cellsSchema,
        })
        .strict()
        .parse(await safeJsonOrEmpty(c.req.raw))
      const snapshot = buildFactSnapshot({
        missionRevision: 0,
        capturedAt: '1970-01-01T00:00:00+00:00',
        cells: body.cells,
      })
      return c.json(
        resolveEmployeeSelection({
          explicitEmployeeRef: body.explicitEmployeeRef,
          assignment: body.assignment,
          explicitFallbackRef: body.explicitFallbackRef,
          snapshot,
        }),
      )
    },
  )
}

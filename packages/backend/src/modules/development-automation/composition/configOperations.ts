// RFC-344 — bootstrap composition for development configuration operations.

import type { ResourceAccess } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  archiveActionTemplate,
  createActionTemplate,
  publishActionTemplate,
  reviseActionTemplateDraft,
} from '../application/commands/actionTemplateCommands'
import {
  archiveVerificationProfile,
  createVerificationProfile,
  publishVerificationProfile,
  reviseVerificationProfileDraft,
} from '../application/commands/verificationProfileCommands'
import {
  archiveAutomationPolicy,
  archiveDigitalEmployee,
  createAutomationPolicy,
  createDigitalEmployee,
  getAutomationPolicy,
  getDigitalEmployee,
  listAutomationPolicies,
  listDigitalEmployees,
  publishAutomationPolicy,
  publishDigitalEmployee,
  reviseAutomationPolicyDraft,
  reviseDigitalEmployeeDraft,
} from '../infrastructure/sqliteDigitalEmployeeStore'
import {
  deleteAssignment,
  listAssignments,
  upsertAssignment,
} from '../infrastructure/sqliteAssignmentStore'
import {
  createSqliteActionTemplateStore,
  createSqliteVerificationProfileStore,
} from '../infrastructure/sqliteConfigResourceStore'
import { createEmployeePublishLookup } from '../infrastructure/publishLookup'
import { evaluatePolicy } from '../engine/policy/evaluatePolicy'
import { resolveEmployeeSelection } from '../engine/policy/workSelection'
import { buildFactSnapshot } from '../domain/facts'
import {
  compileEmployeePlaybook,
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
} from '../domain/digitalEmployee'
import { projectEmployeeSetupJourney } from '../domain/journeyProjection'
import type {
  DevelopmentConfigAclRow,
  DevelopmentConfigIdentityView,
  DevelopmentConfigOperations,
  DevelopmentConfigResourceOperations,
} from '../public/operations'
import {
  assertNameUnchangedForEditor,
  canViewResource,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from '@/services/resourceAcl'
import type { AclResourceType } from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'

interface AclVisibleRow extends DevelopmentConfigAclRow {
  readonly name?: string
}

function identityView(row: {
  readonly id: string
  readonly name: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}): DevelopmentConfigIdentityView {
  return {
    id: row.id,
    name: row.name,
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

async function requireVisible<T extends AclVisibleRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null || !(await canViewResource(db, actor, type, row))) {
    throw new NotFoundError('resource-not-found', 'not found')
  }
  return row
}

async function requireEditable<T extends AclVisibleRow & { readonly name: string }>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<{ readonly row: T; readonly access: ResourceAccess }> {
  if (row === null) throw new NotFoundError('resource-not-found', 'not found')
  const access = await requireResourceEdit(db, actor, type, row)
  return { row, access }
}

async function requireGovernable<T extends AclVisibleRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null) throw new NotFoundError('resource-not-found', 'not found')
  await requireResourceGovern(db, actor, type, row)
  return row
}

export function composeDevelopmentConfigOperations(
  db: DbClient,
  developmentAdapter: DevelopmentConfigResourceOperations,
): DevelopmentConfigOperations {
  const templateStore = createSqliteActionTemplateStore(db)
  const profileStore = createSqliteVerificationProfileStore(db)
  const now = () => Date.now()

  const actionTemplate: DevelopmentConfigResourceOperations = {
    kind: 'action-template',
    async list(actor) {
      return (await filterVisibleRows(db, actor, 'action_template', templateStore.list())).map(
        (row) => {
          const published =
            row.publishedRevision === null
              ? null
              : templateStore.getRevision(row.id, row.publishedRevision)
          let executorKind: 'agent' | 'workgroup' | 'script' | null = null
          if (published !== null) {
            const content = JSON.parse(published.contentJson) as {
              readonly executor?: { readonly kind?: unknown }
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
            ...identityView(row),
            capabilityId: row.extra.capabilityId,
            executorKind,
          }
        },
      )
    },
    async get(actor, id) {
      const row = await requireVisible(db, actor, 'action_template', templateStore.getById(id))
      return {
        ...identityView(row),
        capabilityId: row.extra.capabilityId,
        draft: JSON.parse(row.draftJson) as unknown,
      }
    },
    async create(actor, input) {
      if (input.capabilityId === undefined) {
        throw new ValidationError('action-template-capability-required', 'capabilityId is required')
      }
      return identityView(
        createActionTemplate(
          { store: templateStore, now },
          {
            actorUserId: actor.userId,
            name: input.name,
            capabilityId: input.capabilityId,
            draft: input.draft ?? {},
          },
        ),
      )
    },
    async revise(actor, id, input) {
      const { row, access } = await requireEditable(
        db,
        actor,
        'action_template',
        templateStore.getById(id),
      )
      assertNameUnchangedForEditor(access, row.name, input.name)
      reviseActionTemplateDraft(
        { store: templateStore, now },
        {
          id,
          draft: input.draft ?? {},
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      )
    },
    async publish(actor, id) {
      await requireEditable(db, actor, 'action_template', templateStore.getById(id))
      return publishActionTemplate({ store: templateStore, now }, { id, actorUserId: actor.userId })
    },
    async archive(actor, id) {
      await requireGovernable(db, actor, 'action_template', templateStore.getById(id))
      archiveActionTemplate({ store: templateStore, now }, { id })
    },
    async loadAclRow(id) {
      return templateStore.getById(id)
    },
  }

  const verificationProfile: DevelopmentConfigResourceOperations = {
    kind: 'verification-profile',
    async list(actor) {
      return (await filterVisibleRows(db, actor, 'verification_profile', profileStore.list())).map(
        identityView,
      )
    },
    async get(actor, id) {
      const row = await requireVisible(db, actor, 'verification_profile', profileStore.getById(id))
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        createVerificationProfile(
          { store: profileStore, now },
          { actorUserId: actor.userId, name: input.name, draft: input.draft ?? {} },
        ),
      )
    },
    async revise(actor, id, input) {
      const { row, access } = await requireEditable(
        db,
        actor,
        'verification_profile',
        profileStore.getById(id),
      )
      assertNameUnchangedForEditor(access, row.name, input.name)
      reviseVerificationProfileDraft(
        { store: profileStore, now },
        {
          id,
          draft: input.draft ?? {},
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      )
    },
    async publish(actor, id) {
      await requireEditable(db, actor, 'verification_profile', profileStore.getById(id))
      return publishVerificationProfile(
        { store: profileStore, now },
        { id, actorUserId: actor.userId },
      )
    },
    async archive(actor, id) {
      await requireGovernable(db, actor, 'verification_profile', profileStore.getById(id))
      archiveVerificationProfile({ store: profileStore, now }, { id })
    },
    async loadAclRow(id) {
      return profileStore.getById(id)
    },
  }

  const digitalEmployee: DevelopmentConfigResourceOperations = {
    kind: 'digital-employee',
    async list(actor) {
      return (
        await filterVisibleRows(db, actor, 'digital_employee', await listDigitalEmployees(db))
      ).map((row) => {
        const draft = JSON.parse(row.draftJson) as {
          readonly description?: unknown
          readonly businessStatus?: unknown
          readonly steps?: unknown
        }
        return {
          ...identityView(row),
          description: typeof draft.description === 'string' ? draft.description : '',
          businessStatus: draft.businessStatus === 'disabled' ? 'disabled' : 'enabled',
          stepCount: Array.isArray(draft.steps) ? draft.steps.length : 0,
        }
      })
    },
    async get(actor, id) {
      const row = await requireVisible(
        db,
        actor,
        'digital_employee',
        await getDigitalEmployee(db, id),
      )
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        await createDigitalEmployee(db, {
          name: input.name,
          ownerUserId: actor.userId,
          draft: input.draft ?? {},
        }),
      )
    },
    async revise(actor, id, input) {
      const { row, access } = await requireEditable(
        db,
        actor,
        'digital_employee',
        await getDigitalEmployee(db, id),
      )
      assertNameUnchangedForEditor(access, row.name, input.name)
      await reviseDigitalEmployeeDraft(db, {
        id,
        draft: input.draft ?? {},
        ...(input.name === undefined ? {} : { name: input.name }),
      })
    },
    async publish(actor, id) {
      await requireEditable(db, actor, 'digital_employee', await getDigitalEmployee(db, id))
      return publishDigitalEmployee(db, {
        id,
        publishedBy: actor.userId,
        lookup: createEmployeePublishLookup(db),
      })
    },
    async archive(actor, id) {
      await requireGovernable(db, actor, 'digital_employee', await getDigitalEmployee(db, id))
      await archiveDigitalEmployee(db, id)
    },
    async loadAclRow(id) {
      return getDigitalEmployee(db, id)
    },
  }

  const automationPolicy: DevelopmentConfigResourceOperations = {
    kind: 'automation-policy',
    async list(actor) {
      return (
        await filterVisibleRows(db, actor, 'automation_policy', await listAutomationPolicies(db))
      ).map(identityView)
    },
    async get(actor, id) {
      const row = await requireVisible(
        db,
        actor,
        'automation_policy',
        await getAutomationPolicy(db, id),
      )
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        await createAutomationPolicy(db, {
          name: input.name,
          ownerUserId: actor.userId,
          draft: input.draft ?? {},
        }),
      )
    },
    async revise(actor, id, input) {
      const { row, access } = await requireEditable(
        db,
        actor,
        'automation_policy',
        await getAutomationPolicy(db, id),
      )
      assertNameUnchangedForEditor(access, row.name, input.name)
      await reviseAutomationPolicyDraft(db, {
        id,
        draft: input.draft ?? {},
        ...(input.name === undefined ? {} : { name: input.name }),
      })
    },
    async publish(actor, id) {
      await requireEditable(db, actor, 'automation_policy', await getAutomationPolicy(db, id))
      return publishAutomationPolicy(db, { id, publishedBy: actor.userId })
    },
    async archive(actor, id) {
      await requireGovernable(db, actor, 'automation_policy', await getAutomationPolicy(db, id))
      await archiveAutomationPolicy(db, id)
    },
    async loadAclRow(id) {
      return getAutomationPolicy(db, id)
    },
  }

  const resources = Object.freeze({
    'action-template': actionTemplate,
    'verification-profile': verificationProfile,
    'digital-employee': digitalEmployee,
    'automation-policy': automationPolicy,
    'development-adapter': developmentAdapter,
  })

  const playbookProjection = async (actor: Actor, id: string): Promise<Record<string, unknown>> => {
    const row = await requireVisible(
      db,
      actor,
      'digital_employee',
      await getDigitalEmployee(db, id),
    )
    const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(row.draftJson))
    const violations = parsed.success
      ? validateDigitalEmployeeForPublish(parsed.data, createEmployeePublishLookup(db))
      : parsed.error.issues.map((issue) => ({
          code: 'playbook-schema-invalid',
          where: issue.path.join('/'),
          detail: issue.message,
        }))
    const assignments = await listAssignments(db)
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

  const operations: DevelopmentConfigOperations = {
    resources,
    readEmployeePlaybook: playbookProjection,
    async reviseEmployeePlaybook(actor, id, input) {
      const { row, access } = await requireEditable(
        db,
        actor,
        'digital_employee',
        await getDigitalEmployee(db, id),
      )
      assertNameUnchangedForEditor(access, row.name, input.name)
      digitalEmployeeContentSchema.parse(input.playbook)
      await reviseDigitalEmployeeDraft(db, {
        id,
        draft: input.playbook,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      return { ok: true, nextLocation: `/code/config/employees/${encodeURIComponent(id)}` }
    },
    async validateEmployeePlaybook(actor, id) {
      const projection = await playbookProjection(actor, id)
      return {
        readyToPublish: projection.readyToPublish,
        violations: projection.violations,
        compiled: projection.compiled,
        journey: projection.journey,
      }
    },
    async readSetupJourney(actor, employeeId) {
      const visible = await filterVisibleRows(
        db,
        actor,
        'digital_employee',
        await listDigitalEmployees(db),
      )
      const assignments = await listAssignments(db)
      const hasAssignment = (id: string): boolean =>
        assignments.some((assignment) => assignment.employeeId === id)
      const selected =
        (employeeId === undefined
          ? undefined
          : visible.find((employee) => employee.id === employeeId)) ??
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
      const parsed =
        selected === null
          ? null
          : digitalEmployeeContentSchema.safeParse(JSON.parse(selected.draftJson))
      const ready =
        parsed?.success === true &&
        validateDigitalEmployeeForPublish(parsed.data, createEmployeePublishLookup(db)).length === 0
      return projectEmployeeSetupJourney({
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
        readyToPublish: ready,
      })
    },
    async listAssignments() {
      return listAssignments(db)
    },
    async upsertAssignment(actor, input) {
      return upsertAssignment(db, { ...input, updatedBy: actor.userId })
    },
    async deleteAssignment(scopeKind, scopeRef) {
      await deleteAssignment(db, scopeKind, scopeRef)
    },
    async previewPolicy(input) {
      const snapshot = buildFactSnapshot({
        missionRevision: 0,
        capturedAt: '1970-01-01T00:00:00+00:00',
        cells: input.cells,
      })
      return evaluatePolicy({ guards: input.guards, snapshot, rules: input.rules })
    },
    async previewSelection(input) {
      const snapshot = buildFactSnapshot({
        missionRevision: 0,
        capturedAt: '1970-01-01T00:00:00+00:00',
        cells: input.cells,
      })
      return resolveEmployeeSelection({
        explicitEmployeeRef: input.explicitEmployeeRef,
        assignment: input.assignment,
        explicitFallbackRef: input.explicitFallbackRef,
        snapshot,
      })
    },
  }
  return Object.freeze(operations)
}

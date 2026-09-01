// RFC-344/RFC-349 — provider-neutral development configuration composition.

import type { AclResourceType, ResourceAccess } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { NotFoundError, ValidationError } from '@/util/errors'
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
import { loadEmployeePublishLookup } from '../application/employeePublishLookup'
import type {
  ActionTemplatePersistence,
  VerificationProfilePersistence,
} from '../application/ports/configResourceStore'
import type { DevelopmentConfigPersistence } from '../application/ports/developmentConfigPersistence'
import {
  automationPolicyContentSchema,
  policyContentDigest,
  validatePolicyForPublish,
} from '../domain/automationPolicy'
import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import {
  compileEmployeePlaybook,
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
} from '../domain/digitalEmployee'
import { buildFactSnapshot } from '../domain/facts'
import { projectEmployeeSetupJourney } from '../domain/journeyProjection'
import { evaluatePolicy } from '../engine/policy/evaluatePolicy'
import { resolveEmployeeSelection } from '../engine/policy/workSelection'
import {
  createPostgresqlDevelopmentConfigPersistence,
  createSqliteDevelopmentConfigPersistence,
} from '../infrastructure/developmentConfigPersistence'
import {
  createPostgresqlActionTemplatePersistence,
  createPostgresqlVerificationProfilePersistence,
} from '../infrastructure/postgresqlConfigResourceStore'
import {
  createSqliteActionTemplatePersistence,
  createSqliteVerificationProfilePersistence,
} from '../infrastructure/sqliteConfigResourceStore'
import type {
  DevelopmentConfigAclRow,
  DevelopmentConfigIdentityView,
  DevelopmentConfigOperations,
  DevelopmentConfigResourceOperations,
} from '../public/operations'

type Actor = DirectAuthenticatedAuthority

export interface DevelopmentConfigAccessRow extends DevelopmentConfigAclRow {
  readonly name?: string
}

/** Resource Catalog binds this closed participant at bootstrap. */
export interface DevelopmentConfigResourceAccess {
  filterVisible<T extends DevelopmentConfigAccessRow>(
    actor: Actor,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<T[]>
  canView(actor: Actor, type: AclResourceType, row: DevelopmentConfigAccessRow): Promise<boolean>
  requireEdit(
    actor: Actor,
    type: AclResourceType,
    row: DevelopmentConfigAccessRow,
  ): Promise<ResourceAccess>
  requireGovern(actor: Actor, type: AclResourceType, row: DevelopmentConfigAccessRow): Promise<void>
  assertNameUnchangedForEditor(
    access: ResourceAccess,
    currentName: string,
    submittedName: string | null | undefined,
  ): void
}

export interface DevelopmentConfigCompositionDependencies {
  readonly actionTemplates: ActionTemplatePersistence
  readonly verificationProfiles: VerificationProfilePersistence
  readonly persistence: DevelopmentConfigPersistence
  readonly access: DevelopmentConfigResourceAccess
  readonly developmentAdapter: DevelopmentConfigResourceOperations
  readonly now?: () => number
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

async function requireVisible<T extends DevelopmentConfigAccessRow>(
  access: DevelopmentConfigResourceAccess,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null || !(await access.canView(actor, type, row))) {
    throw new NotFoundError('resource-not-found', 'not found')
  }
  return row
}

async function requireEditable<T extends DevelopmentConfigAccessRow & { readonly name: string }>(
  access: DevelopmentConfigResourceAccess,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<{ readonly row: T; readonly resourceAccess: ResourceAccess }> {
  if (row === null) throw new NotFoundError('resource-not-found', 'not found')
  return { row, resourceAccess: await access.requireEdit(actor, type, row) }
}

async function requireGovernable<T extends DevelopmentConfigAccessRow>(
  access: DevelopmentConfigResourceAccess,
  actor: Actor,
  type: AclResourceType,
  row: T | null,
): Promise<T> {
  if (row === null) throw new NotFoundError('resource-not-found', 'not found')
  await access.requireGovern(actor, type, row)
  return row
}

function invalidDraft(
  code: string,
  issues: readonly { readonly message: string }[],
): ValidationError {
  return new ValidationError(code, issues[0]?.message ?? 'invalid draft', {
    issues: issues.slice(0, 10),
  })
}

export function composeDevelopmentConfigOperationsFromPersistence(
  deps: DevelopmentConfigCompositionDependencies,
): DevelopmentConfigOperations {
  const templateStore = deps.actionTemplates
  const profileStore = deps.verificationProfiles
  const config = deps.persistence
  const access = deps.access
  const now = deps.now ?? (() => Date.now())

  const actionTemplate: DevelopmentConfigResourceOperations = {
    kind: 'action-template',
    async list(actor) {
      return await Promise.all(
        (await access.filterVisible(actor, 'action_template', await templateStore.list())).map(
          async (row) => {
            const published =
              row.publishedRevision === null
                ? null
                : await templateStore.getRevision(row.id, row.publishedRevision)
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
        ),
      )
    },
    async get(actor, id) {
      const row = await requireVisible(
        access,
        actor,
        'action_template',
        await templateStore.getById(id),
      )
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
        await createActionTemplate(
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
      const { row, resourceAccess } = await requireEditable(
        access,
        actor,
        'action_template',
        await templateStore.getById(id),
      )
      access.assertNameUnchangedForEditor(resourceAccess, row.name, input.name)
      await reviseActionTemplateDraft(
        { store: templateStore, now },
        {
          id,
          draft: input.draft ?? {},
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      )
    },
    async publish(actor, id) {
      await requireEditable(access, actor, 'action_template', await templateStore.getById(id))
      return await publishActionTemplate(
        { store: templateStore, now },
        { id, actorUserId: actor.userId },
      )
    },
    async archive(actor, id) {
      await requireGovernable(access, actor, 'action_template', await templateStore.getById(id))
      await archiveActionTemplate({ store: templateStore, now }, { id })
    },
    async loadAclRow(id) {
      return await templateStore.getById(id)
    },
  }

  const verificationProfile: DevelopmentConfigResourceOperations = {
    kind: 'verification-profile',
    async list(actor) {
      return (
        await access.filterVisible(actor, 'verification_profile', await profileStore.list())
      ).map(identityView)
    },
    async get(actor, id) {
      const row = await requireVisible(
        access,
        actor,
        'verification_profile',
        await profileStore.getById(id),
      )
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        await createVerificationProfile(
          { store: profileStore, now },
          { actorUserId: actor.userId, name: input.name, draft: input.draft ?? {} },
        ),
      )
    },
    async revise(actor, id, input) {
      const { row, resourceAccess } = await requireEditable(
        access,
        actor,
        'verification_profile',
        await profileStore.getById(id),
      )
      access.assertNameUnchangedForEditor(resourceAccess, row.name, input.name)
      await reviseVerificationProfileDraft(
        { store: profileStore, now },
        {
          id,
          draft: input.draft ?? {},
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      )
    },
    async publish(actor, id) {
      await requireEditable(access, actor, 'verification_profile', await profileStore.getById(id))
      return await publishVerificationProfile(
        { store: profileStore, now },
        { id, actorUserId: actor.userId },
      )
    },
    async archive(actor, id) {
      await requireGovernable(access, actor, 'verification_profile', await profileStore.getById(id))
      await archiveVerificationProfile({ store: profileStore, now }, { id })
    },
    async loadAclRow(id) {
      return await profileStore.getById(id)
    },
  }

  const digitalEmployee: DevelopmentConfigResourceOperations = {
    kind: 'digital-employee',
    async list(actor) {
      return (
        await access.filterVisible(actor, 'digital_employee', await config.employees.listActive())
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
        access,
        actor,
        'digital_employee',
        await config.employees.get(id),
      )
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        await config.employees.create({
          id: ulid(),
          name: input.name,
          ownerUserId: actor.userId,
          draftJson: JSON.stringify(input.draft ?? {}),
          now: now(),
        }),
      )
    },
    async revise(actor, id, input) {
      const { row, resourceAccess } = await requireEditable(
        access,
        actor,
        'digital_employee',
        await config.employees.get(id),
      )
      access.assertNameUnchangedForEditor(resourceAccess, row.name, input.name)
      await config.employees.revise({
        id,
        draftJson: JSON.stringify(input.draft ?? {}),
        ...(input.name === undefined ? {} : { name: input.name }),
        now: now(),
      })
    },
    async publish(actor, id) {
      const { row } = await requireEditable(
        access,
        actor,
        'digital_employee',
        await config.employees.get(id),
      )
      const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(row.draftJson))
      if (!parsed.success) {
        throw invalidDraft('digital-employee-draft-invalid', parsed.error.issues)
      }
      const lookup = await loadEmployeePublishLookup(parsed.data, config.publishLookup)
      const violations = validateDigitalEmployeeForPublish(parsed.data, lookup)
      if (violations.length > 0) {
        throw new ValidationError(
          'digital-employee-publish-blocked',
          'publish closure check failed',
          { violations },
        )
      }
      const contentJson = canonicalStringify(parsed.data)
      const contentDigest = canonicalDigest(parsed.data)
      return await config.employees.publish({
        id,
        expectedDraftJson: row.draftJson,
        contentJson,
        contentDigest,
        publishedBy: actor.userId,
        now: now(),
      })
    },
    async archive(actor, id) {
      await requireGovernable(access, actor, 'digital_employee', await config.employees.get(id))
      await config.employees.archive(id, now())
    },
    async loadAclRow(id) {
      return await config.employees.get(id)
    },
  }

  const automationPolicy: DevelopmentConfigResourceOperations = {
    kind: 'automation-policy',
    async list(actor) {
      return (
        await access.filterVisible(actor, 'automation_policy', await config.policies.listActive())
      ).map(identityView)
    },
    async get(actor, id) {
      const row = await requireVisible(
        access,
        actor,
        'automation_policy',
        await config.policies.get(id),
      )
      return { ...identityView(row), draft: JSON.parse(row.draftJson) as unknown }
    },
    async create(actor, input) {
      return identityView(
        await config.policies.create({
          id: ulid(),
          name: input.name,
          ownerUserId: actor.userId,
          draftJson: JSON.stringify(input.draft ?? {}),
          now: now(),
        }),
      )
    },
    async revise(actor, id, input) {
      const { row, resourceAccess } = await requireEditable(
        access,
        actor,
        'automation_policy',
        await config.policies.get(id),
      )
      access.assertNameUnchangedForEditor(resourceAccess, row.name, input.name)
      await config.policies.revise({
        id,
        draftJson: JSON.stringify(input.draft ?? {}),
        ...(input.name === undefined ? {} : { name: input.name }),
        now: now(),
      })
    },
    async publish(actor, id) {
      const { row } = await requireEditable(
        access,
        actor,
        'automation_policy',
        await config.policies.get(id),
      )
      const parsed = automationPolicyContentSchema.safeParse(JSON.parse(row.draftJson))
      if (!parsed.success) {
        throw invalidDraft('automation-policy-draft-invalid', parsed.error.issues)
      }
      const violations = validatePolicyForPublish(parsed.data)
      if (violations.length > 0) {
        throw new ValidationError(
          'automation-policy-publish-blocked',
          'policy publish checks failed',
          { violations },
        )
      }
      const contentJson = canonicalStringify(parsed.data)
      const contentDigest = policyContentDigest(parsed.data)
      return await config.policies.publish({
        id,
        expectedDraftJson: row.draftJson,
        contentJson,
        contentDigest,
        publishedBy: actor.userId,
        now: now(),
      })
    },
    async archive(actor, id) {
      await requireGovernable(access, actor, 'automation_policy', await config.policies.get(id))
      await config.policies.archive(id, now())
    },
    async loadAclRow(id) {
      return await config.policies.get(id)
    },
  }

  const resources = Object.freeze({
    'action-template': actionTemplate,
    'verification-profile': verificationProfile,
    'digital-employee': digitalEmployee,
    'automation-policy': automationPolicy,
    'development-adapter': deps.developmentAdapter,
  })

  const playbookProjection = async (actor: Actor, id: string): Promise<Record<string, unknown>> => {
    const row = await requireVisible(
      access,
      actor,
      'digital_employee',
      await config.employees.get(id),
    )
    const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(row.draftJson))
    const violations = parsed.success
      ? validateDigitalEmployeeForPublish(
          parsed.data,
          await loadEmployeePublishLookup(parsed.data, config.publishLookup),
        )
      : parsed.error.issues.map((issue) => ({
          code: 'playbook-schema-invalid',
          where: issue.path.join('/'),
          detail: issue.message,
        }))
    const assignments = await config.assignments.list()
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
      const { row, resourceAccess } = await requireEditable(
        access,
        actor,
        'digital_employee',
        await config.employees.get(id),
      )
      access.assertNameUnchangedForEditor(resourceAccess, row.name, input.name)
      digitalEmployeeContentSchema.parse(input.playbook)
      await config.employees.revise({
        id,
        draftJson: JSON.stringify(input.playbook),
        ...(input.name === undefined ? {} : { name: input.name }),
        now: now(),
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
      const visible = await access.filterVisible(
        actor,
        'digital_employee',
        await config.employees.listActive(),
      )
      const assignments = await config.assignments.list()
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
        validateDigitalEmployeeForPublish(
          parsed.data,
          await loadEmployeePublishLookup(parsed.data, config.publishLookup),
        ).length === 0
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
      return await config.assignments.list()
    },
    async upsertAssignment(actor, input) {
      return await config.assignments.upsert({ ...input, updatedBy: actor.userId, now: now() })
    },
    async deleteAssignment(scopeKind, scopeRef) {
      await config.assignments.delete(scopeKind, scopeRef)
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

/** Existing SQLite bootstrap factory retained as the behavioral oracle. */
export function composeDevelopmentConfigOperations(
  db: DbClient,
  developmentAdapter: DevelopmentConfigResourceOperations,
  access: DevelopmentConfigResourceAccess,
): DevelopmentConfigOperations {
  return composeDevelopmentConfigOperationsFromPersistence({
    actionTemplates: createSqliteActionTemplatePersistence(db),
    verificationProfiles: createSqliteVerificationProfilePersistence(db),
    persistence: createSqliteDevelopmentConfigPersistence(db),
    developmentAdapter,
    access,
  })
}

/** PostgreSQL bootstrap factory; Resource Catalog supplies the bound ACL participant. */
export function composePostgresqlDevelopmentConfigOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly developmentAdapter: DevelopmentConfigResourceOperations
  readonly access: DevelopmentConfigResourceAccess
  readonly now?: () => number
}): DevelopmentConfigOperations {
  return composeDevelopmentConfigOperationsFromPersistence({
    actionTemplates: createPostgresqlActionTemplatePersistence(input.db),
    verificationProfiles: createPostgresqlVerificationProfilePersistence(input.db),
    persistence: createPostgresqlDevelopmentConfigPersistence(input.db),
    developmentAdapter: input.developmentAdapter,
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

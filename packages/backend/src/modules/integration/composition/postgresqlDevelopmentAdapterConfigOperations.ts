import type { ResourceAccess } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import {
  developmentAdapterDefinitionRevisions,
  developmentAdapterDefinitions,
  resourceGrants,
} from '@/db/schema'
import type { DevelopmentConfigResourceOperations } from '@/modules/development-automation/public/operations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  adapterContentDigest,
  developmentAdapterContentSchema,
  requiresScriptsAuthor,
  validateAdapterContract,
  type DevelopmentAdapterContent,
} from '../domain/developmentAdapterDefinition'

interface DevelopmentAdapterAccessRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

export interface PostgresqlDevelopmentAdapterAccess {
  filterVisibleRows<T extends DevelopmentAdapterAccessRow>(
    actor: Actor,
    type: 'development_adapter',
    rows: readonly T[],
  ): Promise<T[]>
  canViewResource(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<boolean>
  resolveResourceAccessFor(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<ResourceAccess>
  requireResourceEdit(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<ResourceAccess>
  requireResourceGovern(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<void>
}

function parseContent(raw: unknown): DevelopmentAdapterContent {
  const parsed = developmentAdapterContentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      'development-adapter-content-invalid',
      `adapter content failed schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    )
  }
  const violations = validateAdapterContract(parsed.data)
  if (violations.length > 0) {
    throw new ValidationError(
      'development-adapter-contract-violation',
      violations.map((violation) => `${violation.code}:${violation.detail}`).join('; '),
    )
  }
  return parsed.data
}

function assertScriptsAuthor(content: DevelopmentAdapterContent, actor: Actor): void {
  if (!requiresScriptsAuthor(content) || actor.permissions.has('scripts:author')) return
  throw new ForbiddenError(
    'scripts-author-required',
    'writing an executable adapter (executableRef/secretProjection) requires scripts:author',
  )
}

function identityView(row: typeof developmentAdapterDefinitions.$inferSelect) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  })
}

function isEditable(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

/** Real asynchronous PostgreSQL owner for development-adapter configuration. */
export function composePostgresqlDevelopmentAdapterConfigOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly access: PostgresqlDevelopmentAdapterAccess
  readonly now?: () => number
  readonly id?: () => string
}): DevelopmentConfigResourceOperations {
  const now = input.now ?? Date.now
  const nextId = input.id ?? ulid

  const load = async (id: string) =>
    (await input.db
      .select()
      .from(developmentAdapterDefinitions)
      .where(eq(developmentAdapterDefinitions.id, id))
      .get()) ?? null

  const operations: DevelopmentConfigResourceOperations = {
    kind: 'development-adapter' as const,
    async list(actor) {
      const rows = await input.db.select().from(developmentAdapterDefinitions).all()
      return (await input.access.filterVisibleRows(actor, 'development_adapter', rows)).map(
        identityView,
      )
    },
    async get(actor, id) {
      const row = await load(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      const access = await input.access.resolveResourceAccessFor(actor, 'development_adapter', row)
      const hasTechnicalAuthority =
        actor.permissions.has('adapter-definitions:update') &&
        actor.permissions.has('scripts:author')
      if (hasTechnicalAuthority && isEditable(access)) {
        return Object.freeze({
          ...identityView(row),
          draft: JSON.parse(row.draftJson) as unknown,
        })
      }
      const explicitGrant = await input.db
        .select({ userId: resourceGrants.userId })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, 'development_adapter'),
            eq(resourceGrants.resourceId, row.id),
            eq(resourceGrants.userId, actor.user.id),
          ),
        )
        .get()
      if (
        explicitGrant !== undefined &&
        (await input.access.canViewResource(actor, 'development_adapter', row))
      ) {
        return identityView(row)
      }
      throw new ForbiddenError(
        'adapter-technical-details-forbidden',
        'reading Adapter executable and secret projection names requires adapter-definitions:update, scripts:author, and ownership',
      )
    },
    async create(actor, rawInput) {
      if (rawInput.purpose === undefined) {
        throw new ValidationError('development-adapter-purpose-required', 'purpose is required')
      }
      const content = parseContent({
        ...(typeof rawInput.draft === 'object' && rawInput.draft !== null ? rawInput.draft : {}),
        purpose: rawInput.purpose,
      })
      assertScriptsAuthor(content, actor)
      const id = nextId()
      const at = now()
      try {
        const created = await input.db
          .insert(developmentAdapterDefinitions)
          .values({
            id,
            name: rawInput.name,
            purpose: content.purpose,
            draftJson: JSON.stringify(content),
            publishedRevision: null,
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
          })
          .returning()
          .get()
        if (created === undefined) throw new Error('development-adapter-insert-missing')
        return identityView(created)
      } catch (error) {
        if (String(error).includes('development_adapter_definitions_owner_name_unique')) {
          throw new ConflictError(
            'development-adapter-name-taken',
            `an adapter named '${rawInput.name}' already exists for this owner`,
          )
        }
        throw error
      }
    },
    async revise(actor, id, rawInput) {
      const row = await load(id)
      if (row === null || row.archivedAt !== null) {
        throw new NotFoundError('resource-not-found', 'not found')
      }
      const access = await input.access.requireResourceEdit(actor, 'development_adapter', row)
      if (rawInput.name !== undefined && rawInput.name !== row.name && access !== 'own') {
        throw new ForbiddenError(
          'resource-rename-owner-only',
          'only the resource owner can rename it',
        )
      }
      const content = parseContent(rawInput.draft)
      if (content.purpose !== row.purpose) {
        throw new ValidationError(
          'development-adapter-purpose-immutable',
          `purpose is fixed at creation (${row.purpose}); create a new adapter instead`,
        )
      }
      assertScriptsAuthor(content, actor)
      await input.db
        .update(developmentAdapterDefinitions)
        .set({
          ...(rawInput.name === undefined ? {} : { name: rawInput.name }),
          draftJson: JSON.stringify(content),
          updatedAt: now(),
        })
        .where(eq(developmentAdapterDefinitions.id, id))
        .run()
    },
    async publish(actor, id) {
      const row = await load(id)
      if (row === null || row.archivedAt !== null) {
        throw new NotFoundError('resource-not-found', 'not found')
      }
      await input.access.requireResourceEdit(actor, 'development_adapter', row)
      const content = parseContent(JSON.parse(row.draftJson))
      assertScriptsAuthor(content, actor)
      const revision = (row.publishedRevision ?? 0) + 1
      const contentJson = JSON.stringify(content)
      const contentDigest = adapterContentDigest(content)
      const at = now()
      await input.db.transaction(async (transaction) => {
        await transaction
          .insert(developmentAdapterDefinitionRevisions)
          .values({
            adapterId: id,
            revision,
            contentJson,
            contentDigest,
            publishedAt: at,
            publishedBy: actor.user.id,
          })
          .run()
        await transaction
          .update(developmentAdapterDefinitions)
          .set({ publishedRevision: revision, updatedAt: at })
          .where(eq(developmentAdapterDefinitions.id, id))
          .run()
      })
      return Object.freeze({ revision, contentDigest })
    },
    async archive(actor, id) {
      const row = await load(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      await input.access.requireResourceGovern(actor, 'development_adapter', row)
      const at = now()
      await input.db
        .update(developmentAdapterDefinitions)
        .set({ archivedAt: at, updatedAt: at })
        .where(eq(developmentAdapterDefinitions.id, id))
        .run()
    },
    async loadAclRow(id) {
      return await load(id)
    },
  }
  return Object.freeze(operations)
}

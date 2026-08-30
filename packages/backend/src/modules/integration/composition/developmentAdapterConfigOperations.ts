// RFC-344 — integration-owned configuration participant for bootstrap wiring.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  archiveDevelopmentAdapter,
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
} from '../application/developmentAdapterCommands'
import { createDevelopmentAdapterResourceCatalogAclAdapter } from '../application/adapters/resource-catalog-acl-adapter'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'
import {
  assertNameUnchangedForEditor,
  canEditResource,
  canViewResource,
  filterVisibleRows,
  listGrantedResourceIds,
  requireResourceEdit,
  requireResourceGovern,
} from '@/services/resourceAcl'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

interface AdapterCreateInput {
  readonly name: string
  readonly draft?: unknown
  readonly purpose?:
    | 'requirement-source'
    | 'pipeline-gate'
    | 'pipeline-classifier'
    | 'approval-gateway'
}

interface AdapterReviseInput {
  readonly name?: string
  readonly draft: unknown
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
}) {
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

export function composeDevelopmentAdapterConfigOperations(db: DbClient) {
  const store = createSqliteDevelopmentAdapterStore(db)
  const now = () => Date.now()
  return Object.freeze({
    kind: 'development-adapter' as const,
    resourceAclIdentity: createDevelopmentAdapterResourceCatalogAclAdapter(store),
    async list(actor: Actor) {
      return (await filterVisibleRows(db, actor, 'development_adapter', store.list())).map(
        (row) => ({
          ...identityView(row),
          purpose: (row as { readonly purpose?: unknown }).purpose,
        }),
      )
    },
    async get(actor: Actor, id: string) {
      const row = store.getById(id)
      const hasTechnicalAuthority =
        actor.permissions.has('adapter-definitions:update') &&
        actor.permissions.has('scripts:author')
      if (
        row !== null &&
        hasTechnicalAuthority &&
        (await canEditResource(db, actor, 'development_adapter', row))
      ) {
        return {
          ...identityView(row),
          purpose: (row as { readonly purpose?: unknown }).purpose,
          draft: JSON.parse(row.draftJson) as unknown,
        }
      }
      if (
        row !== null &&
        (await canViewResource(db, actor, 'development_adapter', row)) &&
        (await listGrantedResourceIds(db, actor, 'development_adapter')).has(row.id)
      ) {
        return {
          ...identityView(row),
          purpose: (row as { readonly purpose?: unknown }).purpose,
        }
      }
      throw new ForbiddenError(
        'adapter-technical-details-forbidden',
        'reading Adapter executable and secret projection names requires adapter-definitions:update, scripts:author, and ownership',
      )
    },
    async create(actor: Actor, input: AdapterCreateInput) {
      if (input.purpose === undefined) {
        throw new ValidationError('development-adapter-purpose-required', 'purpose is required')
      }
      return identityView(
        createDevelopmentAdapter(
          store,
          {
            userId: actor.user.id,
            actorHasScriptsAuthor: actor.permissions.has('scripts:author'),
          },
          {
            name: input.name,
            content: {
              ...(typeof input.draft === 'object' && input.draft !== null ? input.draft : {}),
              purpose: input.purpose,
            },
            now: now(),
          },
        ),
      )
    },
    async revise(actor: Actor, id: string, input: AdapterReviseInput) {
      const row = store.getById(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      const access = await requireResourceEdit(db, actor, 'development_adapter', row)
      assertNameUnchangedForEditor(access, row.name, input.name)
      reviseDevelopmentAdapterDraft(
        store,
        {
          userId: actor.user.id,
          actorHasScriptsAuthor: actor.permissions.has('scripts:author'),
        },
        { id, content: input.draft ?? {}, now: now() },
      )
    },
    async publish(actor: Actor, id: string) {
      const row = store.getById(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      await requireResourceEdit(db, actor, 'development_adapter', row)
      return publishDevelopmentAdapter(
        store,
        {
          userId: actor.user.id,
          actorHasScriptsAuthor: actor.permissions.has('scripts:author'),
        },
        { id, now: now() },
      )
    },
    async archive(actor: Actor, id: string) {
      const row = store.getById(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      await requireResourceGovern(db, actor, 'development_adapter', row)
      archiveDevelopmentAdapter(store, { id, now: now() })
    },
    async loadAclRow(id: string) {
      return store.getById(id)
    },
  })
}

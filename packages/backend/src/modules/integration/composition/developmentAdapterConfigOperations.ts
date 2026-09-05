// RFC-344 — integration-owned configuration participant for bootstrap wiring.
// RFC-359 W4-D6：一份实现，两个 provider 共用。授权面由 resource-catalog 交来（与 development-automation 的其余配置
// 资源同一个 access bag），显式授权事实经目录的 grant 读端口取；store 是中立的 Promise 端口。

import type { ResourceAccess, ResourceGrantLevel } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { DevelopmentConfigResourceOperations } from '@/modules/development-automation/public/operations'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  archiveDevelopmentAdapter,
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
  type DevelopmentAdapterIdentityRow,
} from '../application/developmentAdapterCommands'
import { createDevelopmentAdapterResourceCatalogAclAdapter } from '../application/adapters/resource-catalog-acl-adapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

function identityView(row: DevelopmentAdapterIdentityRow) {
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

interface DevelopmentAdapterAccessRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

/** resource-catalog 交来的授权面——与 development-automation 其余配置资源用的是同一个 access bag（结构装配）。 */
export interface DevelopmentAdapterAccess {
  filterVisible<T extends DevelopmentAdapterAccessRow>(
    actor: Actor,
    type: 'development_adapter',
    rows: readonly T[],
  ): Promise<T[]>
  canView(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<boolean>
  requireEdit(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<ResourceAccess>
  requireGovern(
    actor: Actor,
    type: 'development_adapter',
    row: DevelopmentAdapterAccessRow,
  ): Promise<void>
  assertNameUnchangedForEditor(
    access: ResourceAccess,
    currentName: string,
    submittedName: string | null | undefined,
  ): void
}

/** 目录的 grant 读端口（结构装配）：技术细节以外的读面只对**显式**被授权者开放。 */
export interface DevelopmentAdapterGrantReads {
  loadGrantLevel(
    type: 'development_adapter',
    resourceId: string,
    userId: string,
  ): Promise<ResourceGrantLevel | null>
}

export interface DevelopmentAdapterConfigCompositionInput {
  readonly db: ProviderNeutralDatabase
  readonly access: DevelopmentAdapterAccess
  readonly grants: DevelopmentAdapterGrantReads
  readonly now?: () => number
}

export type DevelopmentAdapterConfigOperations = DevelopmentConfigResourceOperations & {
  readonly resourceAclIdentity: ReturnType<typeof createDevelopmentAdapterResourceCatalogAclAdapter>
}

export function composeDevelopmentAdapterConfigOperationsFor(
  input: DevelopmentAdapterConfigCompositionInput,
): DevelopmentAdapterConfigOperations {
  const store = createDevelopmentAdapterStore(input.db)
  const now = input.now ?? (() => Date.now())
  const actorContext = (actor: Actor) => ({
    userId: actor.user.id,
    actorHasScriptsAuthor: actor.permissions.has('scripts:author'),
  })
  const operations: DevelopmentAdapterConfigOperations = {
    kind: 'development-adapter' as const,
    resourceAclIdentity: createDevelopmentAdapterResourceCatalogAclAdapter(store),
    async list(actor) {
      const rows = await input.access.filterVisible(
        actor,
        'development_adapter',
        await store.list(),
      )
      return rows.map(identityView)
    },
    async get(actor, id) {
      const row = await store.getById(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      const hasTechnicalAuthority =
        actor.permissions.has('adapter-definitions:update') &&
        actor.permissions.has('scripts:author')
      if (hasTechnicalAuthority) {
        const access = await input.access.requireEdit(actor, 'development_adapter', row).then(
          (level) => level,
          () => null,
        )
        if (access !== null) {
          return Object.freeze({
            ...identityView(row),
            draft: JSON.parse(row.draftJson) as unknown,
          })
        }
      }
      const explicitGrant = await input.grants.loadGrantLevel(
        'development_adapter',
        row.id,
        actor.user.id,
      )
      if (
        explicitGrant !== null &&
        (await input.access.canView(actor, 'development_adapter', row))
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
      return identityView(
        await createDevelopmentAdapter(store, actorContext(actor), {
          name: rawInput.name,
          content: {
            ...(typeof rawInput.draft === 'object' && rawInput.draft !== null
              ? rawInput.draft
              : {}),
            purpose: rawInput.purpose,
          },
          now: now(),
        }),
      )
    },
    async revise(actor, id, rawInput) {
      const row = await store.getById(id)
      if (row === null || row.archivedAt !== null) {
        throw new NotFoundError('resource-not-found', 'not found')
      }
      const access = await input.access.requireEdit(actor, 'development_adapter', row)
      input.access.assertNameUnchangedForEditor(access, row.name, rawInput.name)
      await reviseDevelopmentAdapterDraft(store, actorContext(actor), {
        id,
        content: rawInput.draft ?? {},
        ...(rawInput.name === undefined ? {} : { name: rawInput.name }),
        now: now(),
      })
    },
    async publish(actor, id) {
      const row = await store.getById(id)
      if (row === null || row.archivedAt !== null) {
        throw new NotFoundError('resource-not-found', 'not found')
      }
      await input.access.requireEdit(actor, 'development_adapter', row)
      return await publishDevelopmentAdapter(store, actorContext(actor), { id, now: now() })
    },
    async archive(actor, id) {
      const row = await store.getById(id)
      if (row === null) throw new NotFoundError('resource-not-found', 'not found')
      await input.access.requireGovern(actor, 'development_adapter', row)
      await archiveDevelopmentAdapter(store, { id, now: now() })
    },
    async loadAclRow(id) {
      return await store.getById(id)
    },
  }
  return Object.freeze(operations)
}

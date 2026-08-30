// RFC-310 T16 —— development adapter definition 的 application 命令。
//
// identity（ACL + 可变 draft）+ immutable revisions（publish 冻结 canonical
// JSON + digest）。scripts:author 是字段门：draft 含 executable/secret
// projection（adapter 本质上必含）时，create/revise/publish 都要求
// `actorHasScriptsAuthor=true`——权限点判定在路由层完成，这里只收布尔，
// 保持 application 可在无 HTTP 语境下测试（RFC-247 形态）。

import { ForbiddenError, ValidationError } from '@/util/errors'
import {
  adapterContentDigest,
  developmentAdapterContentSchema,
  requiresScriptsAuthor,
  validateAdapterContract,
  type DevelopmentAdapterContent,
} from '@/modules/integration/domain/developmentAdapterDefinition'

export interface DevelopmentAdapterIdentityRow {
  readonly id: string
  readonly name: string
  readonly purpose: DevelopmentAdapterContent['purpose']
  readonly draftJson: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface DevelopmentAdapterAclIdentityMutation {
  readonly current: {
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly aclRevision: number
  }
  readonly ownerNameIsUnique: true
  hasOwnerNameCollision(nextOwnerUserId: string): boolean
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly aclRevision: number
    readonly updatedAt: number
  }): void
}

export interface DevelopmentAdapterAclIdentityPersistence {
  getRevision(resourceId: string): number
  withMutation<T>(
    resourceId: string,
    run: (mutation: DevelopmentAdapterAclIdentityMutation) => T,
  ): T | undefined
}

export interface DevelopmentAdapterStore {
  readonly resourceAclIdentity: DevelopmentAdapterAclIdentityPersistence
  create(input: {
    readonly name: string
    readonly purpose: DevelopmentAdapterContent['purpose']
    readonly draftJson: string
    readonly ownerUserId: string | null
    readonly now: number
  }): DevelopmentAdapterIdentityRow
  getById(id: string): DevelopmentAdapterIdentityRow | null
  list(): DevelopmentAdapterIdentityRow[]
  updateDraft(input: {
    readonly id: string
    readonly draftJson: string
    readonly now: number
  }): void
  publish(input: {
    readonly id: string
    readonly revision: number
    readonly contentJson: string
    readonly contentDigest: string
    readonly publishedBy: string | null
    readonly now: number
  }): void
  archive(input: { readonly id: string; readonly now: number }): void
  getRevision(
    id: string,
    revision: number,
  ): { readonly contentJson: string; readonly contentDigest: string } | null
}

export interface AdapterActorContext {
  readonly userId: string | null
  readonly actorHasScriptsAuthor: boolean
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
      violations.map((v) => `${v.code}:${v.detail}`).join('; '),
    )
  }
  return parsed.data
}

function assertScriptsAuthor(content: DevelopmentAdapterContent, actor: AdapterActorContext): void {
  if (requiresScriptsAuthor(content) && !actor.actorHasScriptsAuthor) {
    throw new ForbiddenError(
      'scripts-author-required',
      'writing an executable adapter (executableRef/secretProjection) requires scripts:author',
    )
  }
}

export function createDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: { readonly name: string; readonly content: unknown; readonly now: number },
): DevelopmentAdapterIdentityRow {
  const content = parseContent(input.content)
  assertScriptsAuthor(content, actor)
  return store.create({
    name: input.name,
    purpose: content.purpose,
    draftJson: JSON.stringify(content),
    ownerUserId: actor.userId,
    now: input.now,
  })
}

export function reviseDevelopmentAdapterDraft(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: { readonly id: string; readonly content: unknown; readonly now: number },
): void {
  const identity = store.getById(input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new ValidationError('development-adapter-not-found', `no active adapter ${input.id}`)
  }
  const content = parseContent(input.content)
  if (content.purpose !== identity.purpose) {
    throw new ValidationError(
      'development-adapter-purpose-immutable',
      `purpose is fixed at creation (${identity.purpose}); create a new adapter instead`,
    )
  }
  assertScriptsAuthor(content, actor)
  store.updateDraft({ id: input.id, draftJson: JSON.stringify(content), now: input.now })
}

export function publishDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: { readonly id: string; readonly now: number },
): { readonly revision: number; readonly contentDigest: string } {
  const identity = store.getById(input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new ValidationError('development-adapter-not-found', `no active adapter ${input.id}`)
  }
  const content = parseContent(JSON.parse(identity.draftJson))
  assertScriptsAuthor(content, actor)
  const revision = (identity.publishedRevision ?? 0) + 1
  const contentJson = JSON.stringify(content)
  const contentDigest = adapterContentDigest(content)
  store.publish({
    id: input.id,
    revision,
    contentJson,
    contentDigest,
    publishedBy: actor.userId,
    now: input.now,
  })
  return { revision, contentDigest }
}

export function archiveDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  input: { readonly id: string; readonly now: number },
): void {
  const identity = store.getById(input.id)
  if (identity === null) {
    throw new ValidationError('development-adapter-not-found', `no adapter ${input.id}`)
  }
  store.archive({ id: input.id, now: input.now })
}

// RFC-310 T16 —— development adapter definition 的 application 命令。
//
// identity（ACL + 可变 draft）+ immutable revisions（publish 冻结 canonical
// JSON + digest）。scripts:author 是字段门：draft 含 executable/secret
// projection（adapter 本质上必含）时，create/revise/publish 都要求
// `actorHasScriptsAuthor=true`——权限点判定在路由层完成，这里只收布尔，
// 保持 application 可在无 HTTP 语境下测试（RFC-247 形态）。
// RFC-359 W4-D6：store 是 Promise 端口（两个 provider 同一份实现），命令随之异步。

import { ForbiddenError, ValidationError } from '@/util/errors'
import {
  adapterContentDigest,
  developmentAdapterContentSchema,
  requiresScriptsAuthor,
  validateAdapterContract,
  type DevelopmentAdapterContent,
} from '@/modules/integration/domain/developmentAdapterDefinition'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

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

/**
 * RFC-359 W4-D6 —— resource-catalog 在目录写事务里向 owner 要的 identity 行：撞名判定与写回都绑定同一个统一事务句柄，
 * `update` 以 aclRevision 为 CAS（false = 有人先写了）。与 resource-catalog 的 `ResourceAclIdentityPersistence` 结构相同——
 * 两个 context 各自声明、bootstrap 结构装配（RFC-317 R2：跨 context 不 import 对方内部）。
 */
export interface DevelopmentAdapterAclIdentityMutation {
  readonly current: {
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly aclRevision: number
  }
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): Promise<boolean>
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly aclRevision: number
    readonly updatedAt: number
  }): Promise<boolean>
}

export interface DevelopmentAdapterAclIdentityPersistence {
  readonly type: 'development_adapter'
  getRevision(resourceId: string): Promise<number>
  loadForMutation(
    transaction: DatabaseTransaction,
    resourceId: string,
  ): Promise<DevelopmentAdapterAclIdentityMutation | undefined>
}

export interface DevelopmentAdapterStore {
  /** resource-catalog 的 ACL 写事务经它读 / 写本 owner 的 identity 行（两个 provider 同一份）。 */
  readonly resourceAclIdentity: DevelopmentAdapterAclIdentityPersistence
  create(input: {
    readonly name: string
    readonly purpose: DevelopmentAdapterContent['purpose']
    readonly draftJson: string
    readonly ownerUserId: string | null
    readonly now: number
  }): Promise<DevelopmentAdapterIdentityRow>
  getById(id: string): Promise<DevelopmentAdapterIdentityRow | null>
  list(): Promise<DevelopmentAdapterIdentityRow[]>
  updateDraft(input: {
    readonly id: string
    readonly draftJson: string
    /** owner 改名（editor 不许改名的判定在调用方）；省略保持原名。 */
    readonly name?: string
    readonly now: number
  }): Promise<void>
  publish(input: {
    readonly id: string
    readonly revision: number
    readonly contentJson: string
    readonly contentDigest: string
    readonly publishedBy: string | null
    readonly now: number
  }): Promise<void>
  archive(input: { readonly id: string; readonly now: number }): Promise<void>
  getRevision(
    id: string,
    revision: number,
  ): Promise<{ readonly contentJson: string; readonly contentDigest: string } | null>
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

export async function createDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: { readonly name: string; readonly content: unknown; readonly now: number },
): Promise<DevelopmentAdapterIdentityRow> {
  const content = parseContent(input.content)
  assertScriptsAuthor(content, actor)
  return await store.create({
    name: input.name,
    purpose: content.purpose,
    draftJson: JSON.stringify(content),
    ownerUserId: actor.userId,
    now: input.now,
  })
}

export async function reviseDevelopmentAdapterDraft(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: {
    readonly id: string
    readonly content: unknown
    readonly name?: string
    readonly now: number
  },
): Promise<void> {
  const identity = await store.getById(input.id)
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
  await store.updateDraft({
    id: input.id,
    draftJson: JSON.stringify(content),
    ...(input.name === undefined || input.name === identity.name ? {} : { name: input.name }),
    now: input.now,
  })
}

export async function publishDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  actor: AdapterActorContext,
  input: { readonly id: string; readonly now: number },
): Promise<{ readonly revision: number; readonly contentDigest: string }> {
  const identity = await store.getById(input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new ValidationError('development-adapter-not-found', `no active adapter ${input.id}`)
  }
  const content = parseContent(JSON.parse(identity.draftJson))
  assertScriptsAuthor(content, actor)
  const revision = (identity.publishedRevision ?? 0) + 1
  const contentJson = JSON.stringify(content)
  const contentDigest = adapterContentDigest(content)
  await store.publish({
    id: input.id,
    revision,
    contentJson,
    contentDigest,
    publishedBy: actor.userId,
    now: input.now,
  })
  return { revision, contentDigest }
}

export async function archiveDevelopmentAdapter(
  store: DevelopmentAdapterStore,
  input: { readonly id: string; readonly now: number },
): Promise<void> {
  const identity = await store.getById(input.id)
  if (identity === null) {
    throw new ValidationError('development-adapter-not-found', `no adapter ${input.id}`)
  }
  await store.archive({ id: input.id, now: input.now })
}

// RFC-310 PR-1B —— digital_employees / automation_policies 的 sqlite store。
//
// 两类资源同构：identity 行（ACL + 可变 draft_json）+ immutable revision 行
// （publish 冻结 canonical JSON + digest，revision 单调递增）。publish 在写入
// 前做 domain 校验（policy：schema+publish validator；employee：schema+闭包
// 检查）；校验不过整个 publish 拒绝，不产生半个 revision。name 冲突由唯一
// 索引兜底转 typed 409。
//
// 这里刻意没有「更新已发布 revision」的 API——编辑永远走 draft → publish 新
// revision（design §3.6「发布产生 immutable revision」）。

import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import {
  automationPolicies,
  automationPolicyRevisions,
  digitalEmployeeRevisions,
  digitalEmployees,
} from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  automationPolicyContentSchema,
  policyContentDigest,
  validatePolicyForPublish,
} from '../domain/automationPolicy'
import { canonicalDigest, canonicalStringify } from '../domain/canonicalJson'
import {
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
  type EmployeePublishLookup,
} from '../domain/digitalEmployee'

export interface DevelopmentResourceIdentity {
  id: string
  name: string
  draftJson: string
  publishedRevision: number | null
  ownerUserId: string | null
  visibility: 'private' | 'public'
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

function uniqueNameGuard(error: unknown, resource: string): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('owner_name_unique') || message.includes('UNIQUE')) {
    throw new ConflictError(`${resource}-name-taken`, `a ${resource} with this name already exists`)
  }
  throw error
}

// ------------------------------------------------------------ employees

export async function createDigitalEmployee(
  db: DbClient,
  input: { name: string; ownerUserId: string | null; draft: unknown },
): Promise<DevelopmentResourceIdentity> {
  // draft 阶段宽容（半成品可存），publish 才 strict parse + 闭包检查。
  const draft = input.draft ?? {}
  const now = Date.now()
  const row = {
    id: ulid(),
    name: input.name,
    draftJson: JSON.stringify(draft),
    publishedRevision: null,
    ownerUserId: input.ownerUserId,
    visibility: 'private' as const,
    aclRevision: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
  try {
    await db.insert(digitalEmployees).values(row)
  } catch (error) {
    uniqueNameGuard(error, 'digital-employee')
  }
  return row
}

export async function getDigitalEmployee(
  db: DbClient,
  id: string,
): Promise<DevelopmentResourceIdentity | null> {
  const rows = await db.select().from(digitalEmployees).where(eq(digitalEmployees.id, id)).limit(1)
  return (rows[0] as DevelopmentResourceIdentity | undefined) ?? null
}

export async function listDigitalEmployees(db: DbClient): Promise<DevelopmentResourceIdentity[]> {
  return (await db
    .select()
    .from(digitalEmployees)
    .where(isNull(digitalEmployees.archivedAt))) as DevelopmentResourceIdentity[]
}

export async function reviseDigitalEmployeeDraft(
  db: DbClient,
  input: { id: string; draft: unknown; name?: string },
): Promise<void> {
  const draft = input.draft ?? {}
  const existing = await getDigitalEmployee(db, input.id)
  if (existing === null || existing.archivedAt !== null) {
    throw new NotFoundError('digital-employee-not-found', 'digital employee not found')
  }
  await db
    .update(digitalEmployees)
    .set({
      draftJson: JSON.stringify(draft),
      updatedAt: Date.now(),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    })
    .where(eq(digitalEmployees.id, input.id))
}

export async function publishDigitalEmployee(
  db: DbClient,
  input: { id: string; publishedBy: string | null; lookup: EmployeePublishLookup },
): Promise<{ revision: number; contentDigest: string }> {
  const identity = await getDigitalEmployee(db, input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new NotFoundError('digital-employee-not-found', 'digital employee not found')
  }
  // 草稿不合法是**用户可达的常规路径**（UI 建出来的员工以空草稿起步，内容在
  // 详情页深编），不是内部错误：裸 `.parse` 抛 ZodError 会被兜底成 500
  // internal-error，用户点一下"发布"就看见崩溃而不是"缺哪些字段"。同族的
  // action template / verification profile 都走 safeParse + 具名 ValidationError，
  // 这里对齐（回归锁见 tests/rfc310-config-create-contract.test.ts）。
  const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(identity.draftJson))
  if (!parsed.success) {
    throw new ValidationError(
      'digital-employee-draft-invalid',
      parsed.error.issues[0]?.message ?? 'invalid draft',
      { issues: parsed.error.issues.slice(0, 10) },
    )
  }
  const content = parsed.data
  const violations = validateDigitalEmployeeForPublish(content, input.lookup)
  if (violations.length > 0) {
    throw new ValidationError('digital-employee-publish-blocked', 'publish closure check failed', {
      violations,
    })
  }
  const revision = (identity.publishedRevision ?? 0) + 1
  const contentJson = canonicalStringify(content)
  await db.insert(digitalEmployeeRevisions).values({
    employeeId: identity.id,
    revision,
    contentJson,
    contentDigest: canonicalDigest(content),
    publishedAt: Date.now(),
    publishedBy: input.publishedBy,
  })
  await db
    .update(digitalEmployees)
    .set({ publishedRevision: revision, updatedAt: Date.now() })
    .where(eq(digitalEmployees.id, identity.id))
  return { revision, contentDigest: canonicalDigest(content) }
}

export async function getDigitalEmployeeRevision(
  db: DbClient,
  id: string,
  revision: number,
): Promise<{ contentJson: string; contentDigest: string } | null> {
  const rows = await db
    .select()
    .from(digitalEmployeeRevisions)
    .where(
      and(
        eq(digitalEmployeeRevisions.employeeId, id),
        eq(digitalEmployeeRevisions.revision, revision),
      ),
    )
    .limit(1)
  const row = rows[0]
  return row === undefined
    ? null
    : { contentJson: row.contentJson, contentDigest: row.contentDigest }
}

export async function archiveDigitalEmployee(db: DbClient, id: string): Promise<void> {
  const existing = await getDigitalEmployee(db, id)
  if (existing === null) throw new NotFoundError('digital-employee-not-found', 'not found')
  await db
    .update(digitalEmployees)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(digitalEmployees.id, id))
}

// ------------------------------------------------------------- policies

export async function createAutomationPolicy(
  db: DbClient,
  input: { name: string; ownerUserId: string | null; draft: unknown },
): Promise<DevelopmentResourceIdentity> {
  const draft = input.draft ?? {}
  const now = Date.now()
  const row = {
    id: ulid(),
    name: input.name,
    draftJson: JSON.stringify(draft),
    publishedRevision: null,
    ownerUserId: input.ownerUserId,
    visibility: 'private' as const,
    aclRevision: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
  try {
    await db.insert(automationPolicies).values(row)
  } catch (error) {
    uniqueNameGuard(error, 'automation-policy')
  }
  return row
}

export async function getAutomationPolicy(
  db: DbClient,
  id: string,
): Promise<DevelopmentResourceIdentity | null> {
  const rows = await db
    .select()
    .from(automationPolicies)
    .where(eq(automationPolicies.id, id))
    .limit(1)
  return (rows[0] as DevelopmentResourceIdentity | undefined) ?? null
}

export async function reviseAutomationPolicyDraft(
  db: DbClient,
  input: { id: string; draft: unknown; name?: string },
): Promise<void> {
  const draft = input.draft ?? {}
  const existing = await getAutomationPolicy(db, input.id)
  if (existing === null || existing.archivedAt !== null) {
    throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
  }
  await db
    .update(automationPolicies)
    .set({
      draftJson: JSON.stringify(draft),
      updatedAt: Date.now(),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    })
    .where(eq(automationPolicies.id, input.id))
}

export async function publishAutomationPolicy(
  db: DbClient,
  input: { id: string; publishedBy: string | null },
): Promise<{ revision: number; contentDigest: string }> {
  const identity = await getAutomationPolicy(db, input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
  }
  // 同 publishDigitalEmployee：revise 对草稿完全宽容（详情页可以存任意 JSON），
  // 所以**发布**就是唯一的校验点，且它是用户可达的常规路径——裸 `.parse` 会把
  // "少了个字段"变成 500 internal-error。具名 422 才说得清缺什么。
  const parsed = automationPolicyContentSchema.safeParse(JSON.parse(identity.draftJson))
  if (!parsed.success) {
    throw new ValidationError(
      'automation-policy-draft-invalid',
      parsed.error.issues[0]?.message ?? 'invalid draft',
      { issues: parsed.error.issues.slice(0, 10) },
    )
  }
  const content = parsed.data
  const violations = validatePolicyForPublish(content)
  if (violations.length > 0) {
    throw new ValidationError('automation-policy-publish-blocked', 'policy publish checks failed', {
      violations,
    })
  }
  const revision = (identity.publishedRevision ?? 0) + 1
  await db.insert(automationPolicyRevisions).values({
    policyId: identity.id,
    revision,
    contentJson: canonicalStringify(content),
    contentDigest: policyContentDigest(content),
    publishedAt: Date.now(),
    publishedBy: input.publishedBy,
  })
  await db
    .update(automationPolicies)
    .set({ publishedRevision: revision, updatedAt: Date.now() })
    .where(eq(automationPolicies.id, identity.id))
  return { revision, contentDigest: policyContentDigest(content) }
}

export async function listAutomationPolicies(db: DbClient): Promise<DevelopmentResourceIdentity[]> {
  return (await db
    .select()
    .from(automationPolicies)
    .where(isNull(automationPolicies.archivedAt))) as DevelopmentResourceIdentity[]
}

export async function archiveAutomationPolicy(db: DbClient, id: string): Promise<void> {
  const identity = await getAutomationPolicy(db, id)
  if (identity === null) {
    throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
  }
  await db
    .update(automationPolicies)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(automationPolicies.id, id))
}

export async function getAutomationPolicyRevision(
  db: DbClient,
  id: string,
  revision: number,
): Promise<{ contentJson: string; contentDigest: string } | null> {
  const rows = await db
    .select()
    .from(automationPolicyRevisions)
    .where(
      and(
        eq(automationPolicyRevisions.policyId, id),
        eq(automationPolicyRevisions.revision, revision),
      ),
    )
    .limit(1)
  const row = rows[0]
  return row === undefined
    ? null
    : { contentJson: row.contentJson, contentDigest: row.contentDigest }
}

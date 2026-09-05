// RFC-310 PR-1B 用例的 digital employee / automation policy 直写助手。
//
// RFC-359 W4-D6b：生产里的 `infrastructure/sqliteDigitalEmployeeStore.ts` 已退役——它唯一的生产消费者
// （迁移落库）改走 `DevelopmentConfigPersistence`。这里把它原来的函数面留给用例，底层走同一份
// provider-中立持久化，于是在两个引擎上都能跑。publish 的 domain 校验（strict parse + 闭包检查 / policy
// publish validator）与生产 configOperations 同一套；`lookup` 参数可省，省略时按生产路径从持久化预载。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { automationPolicyRevisions, digitalEmployeeRevisions } from '@/db/schema'
import { loadEmployeePublishLookup } from '@/modules/development-automation/application/employeePublishLookup'
import type { DevelopmentResourceIdentity } from '@/modules/development-automation/application/ports/developmentConfigPersistence'
import {
  automationPolicyContentSchema,
  policyContentDigest,
  validatePolicyForPublish,
} from '@/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '@/modules/development-automation/domain/canonicalJson'
import {
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
  type EmployeePublishLookup,
} from '@/modules/development-automation/domain/digitalEmployee'
import { createDevelopmentConfigPersistence } from '@/modules/development-automation/infrastructure/developmentConfigPersistence'
import { NotFoundError, ValidationError } from '@/util/errors'

export type { DevelopmentResourceIdentity }

interface RevisionContent {
  readonly contentJson: string
  readonly contentDigest: string
}

// ------------------------------------------------------------ employees

export async function createDigitalEmployee(
  db: ProviderNeutralDatabase,
  input: { readonly name: string; readonly ownerUserId: string | null; readonly draft: unknown },
): Promise<DevelopmentResourceIdentity> {
  // draft 阶段宽容（半成品可存），publish 才 strict parse + 闭包检查。
  return await createDevelopmentConfigPersistence(db).employees.create({
    id: ulid(),
    name: input.name,
    ownerUserId: input.ownerUserId,
    draftJson: JSON.stringify(input.draft ?? {}),
    now: Date.now(),
  })
}

export async function getDigitalEmployee(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<DevelopmentResourceIdentity | null> {
  return await createDevelopmentConfigPersistence(db).employees.get(id)
}

export async function listDigitalEmployees(
  db: ProviderNeutralDatabase,
): Promise<DevelopmentResourceIdentity[]> {
  return [...(await createDevelopmentConfigPersistence(db).employees.listActive())]
}

export async function reviseDigitalEmployeeDraft(
  db: ProviderNeutralDatabase,
  input: { readonly id: string; readonly draft: unknown; readonly name?: string },
): Promise<void> {
  await createDevelopmentConfigPersistence(db).employees.revise({
    id: input.id,
    draftJson: JSON.stringify(input.draft ?? {}),
    ...(input.name === undefined ? {} : { name: input.name }),
    now: Date.now(),
  })
}

export async function publishDigitalEmployee(
  db: ProviderNeutralDatabase,
  input: {
    readonly id: string
    readonly publishedBy: string | null
    readonly lookup?: EmployeePublishLookup
  },
): Promise<{ revision: number; contentDigest: string }> {
  const persistence = createDevelopmentConfigPersistence(db)
  const identity = await persistence.employees.get(input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new NotFoundError('digital-employee-not-found', 'digital employee not found')
  }
  // 草稿不合法是**用户可达的常规路径**：走 safeParse + 具名 ValidationError，不让 ZodError 兜成 500。
  const parsed = digitalEmployeeContentSchema.safeParse(JSON.parse(identity.draftJson))
  if (!parsed.success) {
    throw new ValidationError(
      'digital-employee-draft-invalid',
      parsed.error.issues[0]?.message ?? 'invalid draft',
      { issues: parsed.error.issues.slice(0, 10) },
    )
  }
  const content = parsed.data
  const lookup =
    input.lookup ?? (await loadEmployeePublishLookup(content, persistence.publishLookup))
  const violations = validateDigitalEmployeeForPublish(content, lookup)
  if (violations.length > 0) {
    throw new ValidationError('digital-employee-publish-blocked', 'publish closure check failed', {
      violations,
    })
  }
  return await persistence.employees.publish({
    id: identity.id,
    expectedDraftJson: identity.draftJson,
    contentJson: canonicalStringify(content),
    contentDigest: canonicalDigest(content),
    publishedBy: input.publishedBy,
    now: Date.now(),
  })
}

export async function getDigitalEmployeeRevision(
  db: ProviderNeutralDatabase,
  id: string,
  revision: number,
): Promise<RevisionContent | null> {
  const row = (
    await db
      .select({
        contentJson: digitalEmployeeRevisions.contentJson,
        contentDigest: digitalEmployeeRevisions.contentDigest,
      })
      .from(digitalEmployeeRevisions)
      .where(
        and(
          eq(digitalEmployeeRevisions.employeeId, id),
          eq(digitalEmployeeRevisions.revision, revision),
        ),
      )
      .limit(1)
  )[0]
  return row ?? null
}

export async function archiveDigitalEmployee(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<void> {
  await createDevelopmentConfigPersistence(db).employees.archive(id, Date.now())
}

// ------------------------------------------------------------- policies

export async function createAutomationPolicy(
  db: ProviderNeutralDatabase,
  input: { readonly name: string; readonly ownerUserId: string | null; readonly draft: unknown },
): Promise<DevelopmentResourceIdentity> {
  return await createDevelopmentConfigPersistence(db).policies.create({
    id: ulid(),
    name: input.name,
    ownerUserId: input.ownerUserId,
    draftJson: JSON.stringify(input.draft ?? {}),
    now: Date.now(),
  })
}

export async function getAutomationPolicy(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<DevelopmentResourceIdentity | null> {
  return await createDevelopmentConfigPersistence(db).policies.get(id)
}

export async function reviseAutomationPolicyDraft(
  db: ProviderNeutralDatabase,
  input: { readonly id: string; readonly draft: unknown; readonly name?: string },
): Promise<void> {
  await createDevelopmentConfigPersistence(db).policies.revise({
    id: input.id,
    draftJson: JSON.stringify(input.draft ?? {}),
    ...(input.name === undefined ? {} : { name: input.name }),
    now: Date.now(),
  })
}

export async function publishAutomationPolicy(
  db: ProviderNeutralDatabase,
  input: { readonly id: string; readonly publishedBy: string | null },
): Promise<{ revision: number; contentDigest: string }> {
  const persistence = createDevelopmentConfigPersistence(db)
  const identity = await persistence.policies.get(input.id)
  if (identity === null || identity.archivedAt !== null) {
    throw new NotFoundError('automation-policy-not-found', 'automation policy not found')
  }
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
  return await persistence.policies.publish({
    id: identity.id,
    expectedDraftJson: identity.draftJson,
    contentJson: canonicalStringify(content),
    contentDigest: policyContentDigest(content),
    publishedBy: input.publishedBy,
    now: Date.now(),
  })
}

export async function listAutomationPolicies(
  db: ProviderNeutralDatabase,
): Promise<DevelopmentResourceIdentity[]> {
  return [...(await createDevelopmentConfigPersistence(db).policies.listActive())]
}

export async function archiveAutomationPolicy(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<void> {
  await createDevelopmentConfigPersistence(db).policies.archive(id, Date.now())
}

export async function getAutomationPolicyRevision(
  db: ProviderNeutralDatabase,
  id: string,
  revision: number,
): Promise<RevisionContent | null> {
  const row = (
    await db
      .select({
        contentJson: automationPolicyRevisions.contentJson,
        contentDigest: automationPolicyRevisions.contentDigest,
      })
      .from(automationPolicyRevisions)
      .where(
        and(
          eq(automationPolicyRevisions.policyId, id),
          eq(automationPolicyRevisions.revision, revision),
        ),
      )
      .limit(1)
  )[0]
  return row ?? null
}

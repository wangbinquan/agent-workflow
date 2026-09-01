// RFC-310 T13a —— VerificationProfile application commands。
//
// 与 actionTemplateCommands 同构：draft 宽容、publish 严格。programRef/
// argsRef 的 `scripts:author` 字段级门在 route 集成层挂（沿 RFC-309 的
// 字段级门槛惯例）；此处保证的是 immutable revision 内容永远合法。

import { ulid } from 'ulid'

import { canonicalStringify } from '../../domain/canonicalJson'
import {
  validateVerificationProfileForPublish,
  verificationProfileContentDigest,
  verificationProfileContentSchema,
} from '../../domain/verificationProfile'
import { ValidationError } from '@/util/errors'
import type {
  ConfigResourceRecord,
  VerificationProfilePersistence,
} from '../ports/configResourceStore'

export interface VerificationProfileCommandDeps {
  readonly store: VerificationProfilePersistence
  readonly now: () => number
}

export async function createVerificationProfile(
  deps: VerificationProfileCommandDeps,
  input: { readonly actorUserId: string | null; readonly name: string; readonly draft: unknown },
): Promise<ConfigResourceRecord<Record<never, never>>> {
  if (input.name.trim().length === 0) {
    throw new ValidationError('verification-profile-name-empty', 'name must not be empty')
  }
  return await deps.store.create({
    id: ulid(),
    name: input.name.trim(),
    draftJson: JSON.stringify(input.draft ?? {}),
    ownerUserId: input.actorUserId,
    now: deps.now(),
    extra: {},
  })
}

export async function reviseVerificationProfileDraft(
  deps: VerificationProfileCommandDeps,
  input: { readonly id: string; readonly draft: unknown; readonly name?: string },
): Promise<void> {
  await deps.store.updateDraft({
    id: input.id,
    draftJson: JSON.stringify(input.draft ?? {}),
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    now: deps.now(),
  })
}

export async function publishVerificationProfile(
  deps: VerificationProfileCommandDeps,
  input: { readonly id: string; readonly actorUserId: string | null },
): Promise<{ readonly revision: number; readonly contentDigest: string }> {
  const identity = await deps.store.getById(input.id)
  if (identity === null) {
    throw new ValidationError(
      'verification-profile-not-found',
      `verification profile not found: ${input.id}`,
    )
  }
  if (identity.archivedAt !== null) {
    throw new ValidationError(
      'verification-profile-archived',
      `verification profile is archived: ${input.id}`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(identity.draftJson)
  } catch {
    throw new ValidationError(
      'verification-profile-draft-not-json',
      `verification profile draft is not JSON: ${input.id}`,
    )
  }
  const parsed = verificationProfileContentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      'verification-profile-draft-invalid',
      parsed.error.issues[0]?.message ?? 'invalid draft',
      { issues: parsed.error.issues.slice(0, 10) },
    )
  }
  const violations = validateVerificationProfileForPublish(parsed.data)
  if (violations.length > 0) {
    throw new ValidationError('verification-profile-publish-blocked', violations[0]!.detail, {
      violations,
    })
  }
  const revision = (identity.publishedRevision ?? 0) + 1
  const digest = verificationProfileContentDigest(parsed.data)
  await deps.store.publishRevision({
    resourceId: input.id,
    revision,
    contentJson: canonicalStringify(parsed.data),
    contentDigest: digest,
    publishedAt: deps.now(),
    publishedBy: input.actorUserId,
  })
  return { revision, contentDigest: digest }
}

export async function archiveVerificationProfile(
  deps: VerificationProfileCommandDeps,
  input: { readonly id: string },
): Promise<void> {
  await deps.store.archive(input.id, deps.now())
}

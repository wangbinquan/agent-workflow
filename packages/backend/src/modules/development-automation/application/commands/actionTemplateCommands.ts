// RFC-310 T13 —— ActionTemplate application commands。
//
// create/reviseDraft/publish/archive。draft 阶段允许保存任意结构（用户可以
// 存半成品），但 publish 必须过 strict codec + publish validator——immutable
// revision 里只可能存在完全合法的内容。permission 门在 route 层统一挂
// （registerRoute），此处收 actorUserId 只用于归属；ACL grants 精确过滤随
// route 集成补（见 queries 注释）。

import { ulid } from 'ulid'

import {
  actionTemplateContentSchema,
  actionTemplateContentDigest,
  validateActionTemplateForPublish,
} from '../../domain/actionTemplate'
import { canonicalStringify } from '../../domain/canonicalJson'
import { agentCapabilityIdSchema } from '../../domain/capabilityDefinition'
import { ValidationError } from '@/util/errors'
import type {
  ActionTemplateStore,
  ConfigResourceRecord,
  ActionTemplateExtra,
} from '../ports/configResourceStore'

export interface ActionTemplateCommandDeps {
  readonly store: ActionTemplateStore
  readonly now: () => number
}

export interface CreateActionTemplateInput {
  readonly actorUserId: string | null
  readonly name: string
  readonly capabilityId: string
  readonly draft: unknown
}

export function createActionTemplate(
  deps: ActionTemplateCommandDeps,
  input: CreateActionTemplateInput,
): ConfigResourceRecord<ActionTemplateExtra> {
  const capability = agentCapabilityIdSchema.safeParse(input.capabilityId)
  if (!capability.success) {
    throw new ValidationError(
      'action-template-capability-invalid',
      `not an agent capability: ${input.capabilityId}`,
    )
  }
  if (input.name.trim().length === 0) {
    throw new ValidationError('action-template-name-empty', 'name must not be empty')
  }
  return deps.store.create({
    id: ulid(),
    name: input.name.trim(),
    draftJson: JSON.stringify(input.draft ?? {}),
    ownerUserId: input.actorUserId,
    now: deps.now(),
    extra: { capabilityId: capability.data },
  })
}

export function reviseActionTemplateDraft(
  deps: ActionTemplateCommandDeps,
  input: { readonly id: string; readonly draft: unknown; readonly name?: string },
): void {
  deps.store.updateDraft({
    id: input.id,
    draftJson: JSON.stringify(input.draft ?? {}),
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    now: deps.now(),
  })
}

export interface PublishActionTemplateResult {
  readonly revision: number
  readonly contentDigest: string
}

export function publishActionTemplate(
  deps: ActionTemplateCommandDeps,
  input: { readonly id: string; readonly actorUserId: string | null },
): PublishActionTemplateResult {
  const identity = deps.store.getById(input.id)
  if (identity === null) {
    throw new ValidationError('action-template-not-found', `action template not found: ${input.id}`)
  }
  if (identity.archivedAt !== null) {
    throw new ValidationError(
      'action-template-archived',
      `action template is archived: ${input.id}`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(identity.draftJson)
  } catch {
    throw new ValidationError(
      'action-template-draft-not-json',
      `action template draft is not JSON: ${input.id}`,
    )
  }
  const parsed = actionTemplateContentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      'action-template-draft-invalid',
      parsed.error.issues[0]?.message ?? 'invalid draft',
      {
        issues: parsed.error.issues.slice(0, 10),
      },
    )
  }
  const violations = validateActionTemplateForPublish(parsed.data)
  if (violations.length > 0) {
    throw new ValidationError('action-template-publish-blocked', violations[0]!.detail, {
      violations,
    })
  }
  const revision = (identity.publishedRevision ?? 0) + 1
  deps.store.publishRevision({
    resourceId: input.id,
    revision,
    contentJson: canonicalStringify(parsed.data),
    contentDigest: actionTemplateContentDigest(parsed.data),
    publishedAt: deps.now(),
    publishedBy: input.actorUserId,
  })
  return { revision, contentDigest: actionTemplateContentDigest(parsed.data) }
}

export function archiveActionTemplate(
  deps: ActionTemplateCommandDeps,
  input: { readonly id: string },
): void {
  deps.store.archive(input.id, deps.now())
}

import type { ResourceAccess, WorkflowDefinition } from '@agent-workflow/shared'
import {
  QUARANTINED_FUSION_SKILL_ID,
  WorkflowDefinitionSchema,
  planCanonicalWorkflowLayout,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ConflictError } from '@/util/errors'

export { QUARANTINED_FUSION_SKILL_ID }

export interface FusionSkillToken {
  readonly skillId: string
  readonly contentVersion: number
  readonly metaRevision: number
}

export function encodeFusionSkillToken(token: FusionSkillToken): string {
  return Buffer.from(
    JSON.stringify([token.skillId, token.contentVersion, token.metaRevision]),
    'utf-8',
  ).toString('base64url')
}

export function decodeFusionSkillToken(value: string): FusionSkillToken | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null
  const [skillId, contentVersion, metaRevision] = decoded
  if (typeof skillId !== 'string' || skillId.length === 0) return null
  if (!Number.isInteger(contentVersion) || Number(contentVersion) < 0) return null
  if (!Number.isInteger(metaRevision) || Number(metaRevision) < 0) return null
  return {
    skillId,
    contentVersion: Number(contentVersion),
    metaRevision: Number(metaRevision),
  }
}

export function resolveFusionSkillAccess(
  actor: Actor,
  row: { readonly ownerUserId: string | null; readonly visibility: 'private' | 'public' },
  grant: 'read' | 'write' | null,
): ResourceAccess {
  if (actor.permissions.has('resource-acl:bypass')) return 'own'
  const canReadPrivate = actor.permissions.has('resource-acl:private')
  const publicResource = row.visibility === 'public'
  if (row.ownerUserId === actor.user.id && (publicResource || canReadPrivate)) return 'own'
  if (!canReadPrivate) return publicResource ? 'read' : 'none'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return publicResource ? 'read' : 'none'
}

export function canEditFusionSkill(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

export function repairFusionWorkflowDefinition(
  definition: string,
  mergerAgentId: string,
): { readonly definition: string; readonly changed: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(definition)
  } catch {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition is not valid JSON',
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition is not an object',
    )
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record['nodes'])) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow has no nodes array',
    )
  }
  let mergerFound = false
  let changed = false
  for (const candidate of record['nodes']) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const node = candidate as Record<string, unknown>
    if (node['kind'] !== 'agent-single' || node['id'] !== 'merger') continue
    mergerFound = true
    if (node['agentId'] !== mergerAgentId) {
      node['agentId'] = mergerAgentId
      changed = true
    }
  }
  if (!mergerFound) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow has no merger agent node',
    )
  }
  const shape = WorkflowDefinitionSchema.safeParse(record)
  if (!shape.success) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition does not match the workflow schema',
    )
  }
  const laidOut = planCanonicalWorkflowLayout(record as unknown as WorkflowDefinition).next
  const nextDefinition = JSON.stringify(laidOut)
  if (nextDefinition !== definition) changed = true
  return { definition: changed ? nextDefinition : definition, changed }
}

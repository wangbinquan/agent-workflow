// RFC-544: boot-time alignment of the platform-owned agent rows to their templates, and the public template list
// (moved verbatim from services/digitalEmployeeAgentTemplates.ts).
import {
  canonicalJson,
  CreateAgentSchema,
  type Agent,
  type CreateAgent,
} from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import { ConflictError } from '@/platform/errors/domainErrors'
import {
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2,
  DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2,
} from '../domain/developmentAgentTemplatesV2'
import { DIGITAL_EMPLOYEE_AGENT_TEMPLATES } from '../domain/legacyDigitalEmployeeAgentTemplates'

export type DigitalEmployeeAgentTemplatePersistence = DigitalEmployeeAgentTemplateCatalogParticipant

/**
 * The stored form of one builtin row, re-expressed in the exact shape a
 * template declares it. Comparing two parsed `CreateAgent` values as one
 * canonical string beats a field-by-field checklist, which silently stops
 * covering whatever field `CreateAgent` grows next.
 */
function storedBuiltinAgentDefinition(existing: Agent): CreateAgent {
  return CreateAgentSchema.parse({
    name: existing.name,
    description: existing.description,
    outputs: existing.outputs,
    ...(existing.outputKinds === undefined ? {} : { outputKinds: existing.outputKinds }),
    ...(existing.branchPorts === undefined ? {} : { branchPorts: existing.branchPorts }),
    inputs: existing.inputs,
    ...(existing.outputWrapperPortNames === undefined
      ? {}
      : { outputWrapperPortNames: existing.outputWrapperPortNames }),
    ...(existing.role === undefined ? {} : { role: existing.role }),
    syncOutputsOnIterate: existing.syncOutputsOnIterate,
    ...(existing.runtime === undefined ? {} : { runtime: existing.runtime }),
    permission: existing.permission,
    skills: existing.skills,
    dependsOn: existing.dependsOn,
    mcp: existing.mcp,
    plugins: existing.plugins,
    frontmatterExtra: existing.frontmatterExtra,
    bodyMd: existing.bodyMd,
  })
}

/** Everything except the name, which is repaired through the agent rename. */
function builtinAgentContentSignature(definition: CreateAgent): string {
  const { name: _name, ...content } = CreateAgentSchema.parse(definition)
  return canonicalJson(content)
}

/**
 * Bring one platform-owned row back onto its template.
 *
 * The code is the source of truth for builtin definitions, so drift is
 * REPAIRED at boot, never refused. The earlier create-or-equal rule threw on
 * any difference, which meant one reworded `description` in this repository
 * stopped the daemon dead on every machine that had already seeded the old
 * text — dev boxes and upgraded installs alike — for an edit that cannot break
 * anything. Convergence is also what keeps the two sync paths honest: the
 * legacy loop used to re-sync only when `frontmatterExtra.schemaVersion`
 * moved, so a body edit without a version bump stayed stale forever.
 */
async function reconcileBuiltinAgentTemplate(
  persistence: DigitalEmployeeAgentTemplatePersistence,
  existing: Agent,
  definition: CreateAgent,
): Promise<void> {
  if (existing.name !== definition.name) {
    await persistence.renameBuiltin(existing.id, definition.name)
  }
  if (
    builtinAgentContentSignature(storedBuiltinAgentDefinition(existing)) !==
    builtinAgentContentSignature(definition)
  ) {
    const { name: _stableName, ...contentPatch } = definition
    await persistence.updateBuiltin(existing.id, contentPatch)
  }
}

/**
 * Seed platform-owned templates at daemon boot, not in a schema migration.
 * Migrations must leave an otherwise empty resource database empty; the daemon
 * owns business-resource initialization and can therefore validate collisions.
 */
export async function ensureDigitalEmployeeAgentTemplates(
  persistence: DigitalEmployeeAgentTemplatePersistence,
): Promise<void> {
  const templates: readonly { readonly id: string; readonly definition: CreateAgent }[] = [
    ...DIGITAL_EMPLOYEE_AGENT_TEMPLATES,
    ...DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATES_V2,
  ]
  for (const template of templates) {
    const existing = await persistence.get(template.id)
    if (existing !== null) {
      // The one unrecoverable case: a row that is not ours squats the stable
      // id. Converging that would overwrite somebody's own Agent, so the
      // daemon refuses instead of repairing.
      //
      // `visibility` is deliberately NOT part of this check. It is an ACL
      // decision with its own endpoint and audit trail, so a builtin that an
      // administrator made private drops out of
      // `listDigitalEmployeeAgentTemplates` (which filters on public) without
      // costing anyone their daemon.
      if (existing.ownerUserId !== SYSTEM_USER_ID || existing.builtin !== true) {
        throw new ConflictError(
          'builtin-agent-id-collision',
          `stable digital employee Agent id '${template.id}' is occupied`,
        )
      }
      await reconcileBuiltinAgentTemplate(persistence, existing, template.definition)
      continue
    }
    await persistence.createBuiltin(template.id, template.definition)
  }
}

export async function listDigitalEmployeeAgentTemplates(
  persistence: DigitalEmployeeAgentTemplatePersistence,
): Promise<Agent[]> {
  const resolved = await Promise.all(
    DEVELOPMENT_DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS_V2.map((id) => persistence.get(id)),
  )
  return resolved.filter(
    (agent): agent is Agent =>
      agent !== null && agent.builtin === true && agent.visibility === 'public',
  )
}

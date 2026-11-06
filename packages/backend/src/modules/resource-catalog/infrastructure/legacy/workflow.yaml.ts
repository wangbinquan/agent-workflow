// P-4-08: YAML export for workflows.
//
// Export: dump the canonical Workflow object (id + name + description +
// definition) as YAML — RFC-454: the serializer itself is shared's `stringifyWorkflowYaml`; preview parses an
// import request without writing. RFC-401 T6 (proposal G5): the test-only YAML import
// writer is deleted — no production route imported a workflow through it.

import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  type WorkflowDefinition,
  type WorkflowDefinitionSelector,
  stripCallWorkflowNodeIds,
  WorkflowDefinitionSelectorSchema,
  WorkflowNameSchema,
} from '@agent-workflow/shared'

import { inArray } from 'drizzle-orm'
import { parse as parseYaml } from 'yaml'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { filterVisibleRows } from '@/modules/resource-catalog/composition/resourceAcl'
import { WORKFLOW_NAME_INVALID_MESSAGE } from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { ValidationError } from '@/util/errors'

export interface YamlImportPreview {
  /** Workflow id parsed from YAML, if any. */
  id: string | null
  name: string
  description: string
  definition: WorkflowDefinitionSelector
  /** True when a workflow with `id` already exists in DB. */
  conflicts: boolean
}

/**
 * Parse + validate a YAML payload without persisting it. The route layer can
 * use this to render a Preview dialog before deciding on the conflict policy.
 */
export function previewWorkflowYaml(yamlText: string): Omit<YamlImportPreview, 'conflicts'> {
  const raw = safeParse(yamlText)
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError('workflow-yaml-invalid', 'YAML did not parse to an object')
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : null
  if (name === null) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML missing required field: name')
  }
  // 2026-07-10 naming unification: an import always mints a NEW name, so the
  // shared name rules apply flat — a YAML whose name breaks them gets an
  // explicit 422 (edit the YAML's name line and retry). Decided over
  // auto-slugging to avoid silent renames. RFC-264 widened the rule to
  // human-readable names, and the parse also folds the name (NFC / spaces).
  const nameOk = WorkflowNameSchema.safeParse(name)
  if (!nameOk.success) {
    throw new ValidationError('workflow-name-invalid', WORKFLOW_NAME_INVALID_MESSAGE, {
      issues: nameOk.error.issues,
    })
  }
  const id = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : null
  const description = typeof obj.description === 'string' ? obj.description : ''
  const definitionRaw = obj.definition
  const parsed = WorkflowDefinitionSelectorSchema.safeParse(definitionRaw)
  if (!parsed.success) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML definition failed schema validation', {
      issues: parsed.error.issues,
    })
  }
  // RFC-264: hand back the FOLDED name — an import mints a new name, and the
  // conflict dialog compares it against existing rows, which are folded too.
  return { id, name: nameOk.data, description, definition: parsed.data }
}

/**
 * Convert one immutable persisted workflow snapshot into its portable YAML
 * selector shape. The current canonical agent row supplies both the display
 * name and owner hint; installation-local ids never leave this boundary.
 */
export async function workflowDefinitionToSelectors(
  db: PersistenceDb,
  actor: Actor,
  definition: WorkflowDefinition,
): Promise<WorkflowDefinitionSelector> {
  // RFC-243 (§5.5): call-workflow nodes drop their installation-local
  // `workflowId` cache up-front — `workflowName` (already on the node) is the
  // portable selector, so no owner/name directory lookup is needed for them.
  definition = stripCallWorkflowNodeIds(definition)
  const agentIds = [
    ...new Set(
      definition.nodes
        .filter((node) => node.kind === 'agent-single')
        .map((node) => node.agentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  if (
    definition.nodes.some(
      (node) =>
        node.kind === 'agent-single' &&
        (typeof node.agentId !== 'string' || node.agentId.length === 0),
    )
  ) {
    throw new ValidationError(
      'workflow-export-ref-unavailable',
      'workflow contains an agent node without a canonical agent id',
    )
  }
  if (agentIds.length === 0) {
    return WorkflowDefinitionSelectorSchema.parse(definition)
  }

  const { agents } = tablesOf(db)

  const { users } = tablesOf(db)
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(inArray(agents.id, agentIds))
  const visible = await filterVisibleRows(db, actor, 'agent', rows)
  const byId = new Map(visible.map((row) => [row.id, row]))
  if (byId.size !== agentIds.length) {
    throw new ValidationError(
      'workflow-export-ref-unavailable',
      'workflow references an agent that is missing or no longer visible',
    )
  }

  const ownerIds = [
    ...new Set(
      visible
        .map((row) => row.ownerUserId)
        .filter(
          (ownerUserId): ownerUserId is string =>
            ownerUserId !== null && ownerUserId !== SYSTEM_USER_ID,
        ),
    ),
  ]
  const ownerRows =
    ownerIds.length === 0
      ? []
      : await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, ownerIds))
  const usernameById = new Map(ownerRows.map((row) => [row.id, row.username]))

  return WorkflowDefinitionSelectorSchema.parse({
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent-single') return node
      const agentId = node.agentId
      const row = agentId === undefined ? undefined : byId.get(agentId)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-export-ref-unavailable',
          'workflow references an agent that is missing or no longer visible',
        )
      }
      const ownerUsername =
        row.ownerUserId === SYSTEM_USER_ID
          ? SYSTEM_USER_ID
          : row.ownerUserId === null
            ? undefined
            : usernameById.get(row.ownerUserId)
      if (row.ownerUserId !== null && ownerUsername === undefined) {
        throw new ValidationError(
          'workflow-export-owner-unavailable',
          'workflow agent owner no longer has a portable username',
        )
      }
      const record = node as Record<string, unknown>
      const {
        agentId: _agentId,
        agentName: _agentName,
        agentOwnerUsername: _agentOwnerUsername,
        ...portable
      } = record
      return {
        ...portable,
        agentName: row.name,
        ...(ownerUsername === undefined ? {} : { agentOwnerUsername: ownerUsername }),
      }
    }),
  })
}

function safeParse(yamlText: string): unknown {
  try {
    return parseYaml(yamlText)
  } catch (err) {
    throw new ValidationError(
      'workflow-yaml-invalid',
      `YAML parse error: ${(err as Error).message}`,
    )
  }
}

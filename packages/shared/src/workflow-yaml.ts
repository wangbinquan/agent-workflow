// RFC-199 — one browser/server-safe YAML serializer for workflow snapshots.
//
// Backend exact export and frontend terminal-draft export must produce the
// same document shape. Keeping this pure in shared also prevents the deleted
// / inaccessible editor path from depending on a live API row.

import { stringify as stringifyYaml } from 'yaml'
import {
  WorkflowDefinitionSelectorSchema,
  WorkflowDraftSnapshotSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionSelector,
  type WorkflowDraftSnapshot,
} from './schemas/workflow'

export interface WorkflowYamlDocumentOptions {
  /** Persisted exports include the id; an unsaved copy may intentionally omit it. */
  id?: string
}

/**
 * Browser-safe fallback for an unsaved workflow draft. The browser has no
 * authoritative owner directory, so it emits name-only portable selectors and
 * lets the import mapping flow disambiguate them. Installation-local ids are
 * never written into an importable YAML artifact.
 */
export function workflowDefinitionToNameSelectors(
  definition: WorkflowDefinition,
): WorkflowDefinitionSelector {
  return WorkflowDefinitionSelectorSchema.parse({
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent-single') return node
      const { agentId: _agentId, ...portable } = node
      return portable
    }),
  })
}

export function stringifyWorkflowYamlDocument(
  snapshot: WorkflowDraftSnapshot,
  options: WorkflowYamlDocumentOptions = {},
): string {
  const normalized = WorkflowDraftSnapshotSchema.parse(snapshot)
  const payload = {
    ...(options.id === undefined ? {} : { id: options.id }),
    name: normalized.name,
    description: normalized.description,
    definition: normalized.definition,
  }
  return stringifyYaml(payload, { indent: 2, lineWidth: 120 })
}

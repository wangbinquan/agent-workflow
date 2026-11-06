// RFC-199 — one browser/server-safe YAML serializer for workflow snapshots.
//
// Backend exact export and frontend terminal-draft export must produce the
// same document shape. Keeping this pure in shared also prevents the deleted
// / inaccessible editor path from depending on a live API row.

import { stringify as stringifyYaml } from 'yaml'
import {
  WorkflowDefinitionSelectorSchema,
  WorkflowDraftSnapshotSchema,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowDefinitionSelector,
  type WorkflowDraftSnapshot,
} from './schemas/workflow'

export interface WorkflowYamlDocumentOptions {
  /** Persisted exports include the id; an unsaved copy may intentionally omit it. */
  id?: string
}

/**
 * RFC-243 (§5.5) — strip the installation-local `workflowId` resolution cache
 * from call-workflow nodes. `workflowName` (the authoritative, portable
 * selector) already lives on the node, so exports carry the name alone and the
 * import boundary re-resolves (or deliberately keeps dangling) against the
 * target install. Pure; only call-workflow nodes are touched.
 */
export function stripCallWorkflowNodeIds(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind === 'call-workflow') {
        const rec = node as Record<string, unknown>
        if (!('workflowId' in rec)) return node
        const { workflowId: _drop, ...rest } = rec
        return rest as typeof node
      }
      // RFC-243 PR-4 — call-workgroup carries the same local-id cache shape.
      if (node.kind === 'call-workgroup') {
        const rec = node as Record<string, unknown>
        if (!('workgroupId' in rec)) return node
        const { workgroupId: _drop, ...rest } = rec
        return rest as typeof node
      }
      return node
    }),
  }
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
  const withoutCallIds = stripCallWorkflowNodeIds(definition)
  return WorkflowDefinitionSelectorSchema.parse({
    ...withoutCallIds,
    nodes: withoutCallIds.nodes.map((node) => {
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

/**
 * Serialize an already-captured workflow row. Callers that also perform an
 * ACL/revision guard must pass that exact immutable snapshot here instead of
 * re-reading by id after the guard (RFC-199 B1/B3).
 *
 * RFC-454: moved here from the backend's resource-catalog legacy directory — it is a thin adapter over
 * `stringifyWorkflowYamlDocument`, and the platform's portable backup assets need it without reaching a module.
 */
export function stringifyWorkflowYaml(
  wf: Pick<Workflow, 'id' | 'name' | 'description'> & {
    definition: WorkflowDefinition | WorkflowDefinitionSelector
  },
): string {
  return stringifyWorkflowYamlDocument(
    {
      name: wf.name,
      description: wf.description,
      // The shared serializer deliberately accepts the canonical definition
      // schema for full-fidelity backups. Portable selectors are a strict
      // no-agentId subset with passthrough selector metadata, so they normalize
      // through that same serializer without widening the import schema.
      definition: wf.definition as WorkflowDefinition,
    },
    { id: wf.id },
  )
}

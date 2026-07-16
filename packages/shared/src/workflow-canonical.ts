// RFC-199 — one canonical JSON implementation for workflow persistence,
// optimistic-revision fingerprints, and semantic workflow diffing.
//
// A first JSON.stringify/parse pass applies the JSON data-model rules we want
// (undefined object members omitted, undefined array entries become null,
// toJSON honored). We then emit the normalized tree ourselves so integer-like
// object keys also stay in lexical order: native JSON.stringify always moves
// array-index keys into numeric order even when a replacer inserted them in a
// different order. Arrays are deliberately left untouched because their order
// is semantic.

import {
  WorkflowDefinitionSchema,
  WorkflowDraftSnapshotSchema,
  type WorkflowDefinition,
  type WorkflowDraftSnapshot,
} from './schemas/workflow'

export const WORKFLOW_EDITABLE_SNAPSHOT_DOMAIN_V1 = 'workflow-editable-snapshot/v1\n'

/** Deterministic JSON with recursively sorted object keys and ordered arrays. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('canonicalJson requires a JSON-serializable top-level value')
  }
  return emitCanonicalJson(JSON.parse(serialized) as JsonValue)
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function emitCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(emitCanonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${emitCanonicalJson(value[key]!)}`)
    .join(',')}}`
}

/**
 * Exact latest physical representation for `workflows.definition`.
 * Callers that migrate older definitions do so before this boundary; parsing
 * here still applies schema defaults and removes unsupported root fields.
 */
export function serializeWorkflowDefinitionStorageV1(definition: WorkflowDefinition): string {
  return canonicalJson(WorkflowDefinitionSchema.parse(definition))
}

/**
 * Domain-separated canonical string whose UTF-8 SHA-256 is `snapshotHash`.
 * Hashing deliberately stays with the runtime-specific caller (node:crypto in
 * the backend, Web Crypto in the browser) so shared remains browser-safe.
 */
export function serializeWorkflowEditableSnapshotV1(snapshot: WorkflowDraftSnapshot): string {
  return `${WORKFLOW_EDITABLE_SNAPSHOT_DOMAIN_V1}${canonicalJson(
    WorkflowDraftSnapshotSchema.parse(snapshot),
  )}`
}

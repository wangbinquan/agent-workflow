// RFC-023 — transparent $schema_version migration v1/v2 → v3.
//
// Mirrors RFC-005's v1→v2 contract: GET path upgrades old docs in-memory
// without touching the DB; next PUT (auto-save / YAML re-import) flushes
// the bumped version. The migrator is a pure helper exported from
// services/workflow.ts, so this test stays free of daemon/DB plumbing.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { migrateDefinitionToLatest } from '../src/modules/resource-catalog/infrastructure/legacy/workflow'

const linearDef = (schemaVersion: 1 | 2 | 3): WorkflowDefinition => ({
  $schema_version: schemaVersion,
  inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
  nodes: [
    { id: 'i1', kind: 'input', inputKey: 'requirement' },
    { id: 'a1', kind: 'agent-single', agentName: 'designer' },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'i1', portName: 'requirement' },
      target: { nodeId: 'a1', portName: 'requirement' },
    },
  ],
})

describe('migrateDefinitionToLatest (RFC-023 v2→v3 transparent upgrade)', () => {
  test('v1 doc walks all the way to v3', () => {
    const out = migrateDefinitionToLatest(linearDef(1))
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    // shape preserved (no clarify nodes injected — v1 never had them)
    expect(out.nodes.map((n) => n.kind)).toEqual(['input', 'agent-single'])
  })

  test('v2 doc upgrades to v3 with shape preserved', () => {
    const out = migrateDefinitionToLatest(linearDef(2))
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(out.nodes.length).toBe(2)
    expect(out.edges.length).toBe(1)
  })

  test('v3 doc walks to the latest version (RFC-056 v3→v4 pure metadata bump preserves shape)', () => {
    const v3 = linearDef(3)
    const out = migrateDefinitionToLatest(v3)
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    // Nodes / edges round-trip without surprise mutation (v3→v4 is metadata-only).
    expect(out.nodes).toEqual(v3.nodes)
    expect(out.edges).toEqual(v3.edges)
  })
})

// RFC-354 T12 — every shipped example workflow (`examples/workflows/**`) is a
// golden input for the v5 → v6 upgrader:
//
//   • it upgrades to WORKFLOW_SCHEMA_VERSION, and upgrading the result again
//     is a no-op (idempotent);
//   • no retired node-level PortRef field survives (`review.inputSource`,
//     `output.ports`, `wrapper-loop.outputBindings`, `exitCondition.nodeId`,
//     `wrapper-fanout.inputs`);
//   • the upgraded document still parses against the strict v6 zod schema;
//   • the validator raises none of the RFC-354 edge-model codes on it — the
//     examples reference agents by name only, so agent-scoped codes
//     (`agent-not-found`, port-kind checks) are outside this lock.
//
// The daemon-level matrix (`e2e/workflow-matrix.spec.ts`) executes the same
// files; this test keeps the schema-level contract fast and provider-free.

import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateWorkflowDef } from '../src/services/workflow.validator'

const EXAMPLES_ROOT = resolve(import.meta.dir, '..', '..', '..', 'examples', 'workflows')

function listYaml(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listYaml(full))
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full)
  }
  return out.sort()
}

const RETIRED_NODE_FIELDS: Record<string, readonly string[]> = {
  review: ['inputSource'],
  output: ['ports'],
  'wrapper-loop': ['outputBindings'],
  'wrapper-fanout': ['inputs'],
}

/** Codes that only the RFC-354 edge model can raise — a golden example must be clean of them. */
const EDGE_MODEL_CODES = new Set([
  'wrapper-loop-exit-port-missing',
  'wrapper-loop-output-binding-out-of-scope',
  'wrapper-loop-exit-condition',
  'wrapper-fanout-shard-source-missing',
  'wrapper-fanout-shard-source-must-be-list',
  'review-input-source-missing',
  'review-input-edge-conflict',
  'wrapper-output-boundary-missing',
  'wrapper-input-boundary-missing',
  'wrapper-input-port-missing',
  'edge-source-node-missing',
  'edge-target-node-missing',
  'boundary-output-source-not-inner',
  'boundary-output-target-not-wrapper',
])

const files = listYaml(EXAMPLES_ROOT)

describe('RFC-354 — example workflows are v6 upgrader goldens', () => {
  test('the catalog is the 33-file example set', () => {
    expect(files.length).toBe(33)
  })

  for (const file of files) {
    const label = relative(EXAMPLES_ROOT, file)
    test(label, () => {
      const doc = parseYaml(readFileSync(file, 'utf-8')) as { definition: WorkflowDefinition }
      const once = migrateWorkflowDefinitionToLatest(doc.definition)
      expect(once.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
      expect(migrateWorkflowDefinitionToLatest(once)).toEqual(once)

      for (const node of once.nodes) {
        const record = node as unknown as Record<string, unknown>
        for (const field of RETIRED_NODE_FIELDS[node.kind] ?? []) {
          expect(field in record, `${label}: ${node.id} still carries ${field}`).toBe(false)
        }
        if (node.kind === 'wrapper-loop') {
          const exit = record.exitCondition as Record<string, unknown> | undefined
          expect(exit !== undefined && 'nodeId' in exit, `${label}: ${node.id} exit nodeId`).toBe(
            false,
          )
        }
      }

      const parsed = WorkflowDefinitionSchema.safeParse(once)
      expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true)

      const edgeModelIssues = validateWorkflowDef(once, { agents: [], skills: [] }).issues.filter(
        (issue) => EDGE_MODEL_CODES.has(issue.code),
      )
      expect(edgeModelIssues, `${label}: ${JSON.stringify(edgeModelIssues)}`).toEqual([])
    })
  }
})
